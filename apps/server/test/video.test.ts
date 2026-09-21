import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { VideoService } from '../src/video.js'
import type { VerifiedIdentity } from '../src/types.js'

const identity: VerifiedIdentity = {issuer: 'https://issuer.test', subject: 'user1', platform: 'desktop', clientId: 'app', clientType: 'desktop', scopes: ['ai:invoke']}
const account = {userId: 1, platform: 'desktop', apiKey: 'relay-private-key', quota: 100000}
function material(quoteId: string) {
  const form = new FormData(); form.set('quoteId', quoteId); form.set('script', '测试文案')
  form.set('avatar', new File([new Uint8Array([137,80,78,71,13,10,26,10,0])], '头像.png'))
  form.set('voice', new File(['0000ftypM4A 0000'], '参考录音.m4a'))
  return form
}
test('account gateway uploads, creates once across restart, enforces ownership, and downloads through Relay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ejb-account-')); let submits = 0; let uploads = 0
  const request: typeof fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/digital-human/')) {
      uploads++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer vendor-private-key')
      return Response.json(path.endsWith('avatars') ? {avatar_id: 'a1'} : {voice_id: 'v1'})
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer relay-private-key')
    if (path.endsWith('/v1/tasks/ejianbao')) {submits++; return Response.json({task_id: 'task_1'})}
    if (path.endsWith('/artifacts/video/content')) return new Response('test-video', {headers: {'content-type': 'video/mp4'}})
    return Response.json({task_id: 'task_1', status: 'SUCCESS', progress: '100%'})
  }
  const cfg = {database: join(root, 'video.sqlite'), inferflowUrl: 'https://vendor.test/openapi/v1', inferflowKey: 'vendor-private-key', relayUrl: 'https://relay.test', quotaPerSecond: 10, maxUploadBytes: 1024}
  let service = new VideoService(cfg, request)
  const appConfig = loadConfig({LOGTO_ISSUER: identity.issuer, LOGTO_AUDIENCE: 'audience'})
  const app = () => createApp(appConfig, {video: service, verifier: {verify: async token => ({...identity, subject: token === 'other' ? 'user2' : 'user1'})}, accounts: {resolve: async () => account}})
  const headers = {authorization: 'Bearer user'}
  try {
    assert.equal((await app().request('/v1/ejianbao/quotes', {method: 'POST', body: '{}'})).status, 401)
    const quoted = await app().request('/v1/ejianbao/quotes', {method: 'POST', headers, body: JSON.stringify({script: '测试文案'})})
    const quote = await quoted.json() as {id: string; amount: number}; assert.equal(quote.amount, 100)
    const create = () => app().request('/v1/ejianbao/runs', {method: 'POST', headers: {...headers, 'idempotency-key': 'local-job'}, body: material(quote.id)})
    const response = await create(); assert.equal(response.status, 201)
    const run = await response.json() as {id: string}
    service.close(); service = new VideoService(cfg, request)
    assert.equal((await create()).status, 201); assert.equal(submits, 1); assert.equal(uploads, 2)
    const denied = await app().request(`/v1/ejianbao/runs/${run.id}`, {headers: {authorization: 'Bearer other'}})
    assert.equal(denied.status, 404)
    const done = await app().request(`/v1/ejianbao/runs/${run.id}`, {headers})
    assert.equal((await done.json() as {status: string}).status, 'completed')
    const video = await app().request(`/v1/ejianbao/runs/${run.id}/video`, {headers}); assert.equal(await video.text(), 'test-video')
    assert.equal((await app().request(`/v1/ejianbao/runs/${run.id}/cancel`, {method: 'POST', headers})).status, 409)
    const low = service.quote(identity, {script: '测试文案'})
    await assert.rejects(service.create(identity, {...account, quota: 0}, 'low', material(low.id)), {code: 'VIDEO_QUOTA_LOW'})
    assert.equal(submits, 1)
  } finally {service.close(); rmSync(root, {recursive: true, force: true})}
})

test('an ambiguous paid submission is not repeated after restart or retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ejb-unknown-')); let submits = 0
  const cfg = {database: join(root, 'video.sqlite'), inferflowUrl: 'https://vendor.test', inferflowKey: 'secret', relayUrl: 'https://relay.test', quotaPerSecond: 10, maxUploadBytes: 1024}
  const request: typeof fetch = async url => {
    if (String(url).includes('/digital-human/')) return Response.json(String(url).endsWith('avatars') ? {avatar_id: 'a1'} : {voice_id: 'v1'})
    submits++; throw new Error('connection lost after submission')
  }
  let service = new VideoService(cfg, request)
  try {
    const quote = service.quote(identity, {script: '测试文案'})
    await assert.rejects(service.create(identity, account, 'same', material(quote.id)), {code: 'VIDEO_SUBMISSION_UNKNOWN'})
    service.close(); service = new VideoService(cfg, request)
    await assert.rejects(service.create(identity, account, 'same', material(quote.id)), {code: 'VIDEO_SUBMISSION_UNKNOWN'})
    assert.equal(submits, 1)
  } finally {service.close(); rmSync(root, {recursive: true, force: true})}
})

test('stale material preparation is reported for review instead of polling forever', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ejb-stale-'))
  const database = join(root, 'video.sqlite')
  const service = new VideoService({database, inferflowUrl: 'https://vendor.test', inferflowKey: 'secret', relayUrl: 'https://relay.test', quotaPerSecond: 10, maxUploadBytes: 1024}, async () => {throw new Error('upload failed')})
  try {
    const quote = service.quote(identity, {script: '测试文案'}, {...account, quotaDisplayType: 'CNY', quotaPerUnit: 500000, usdExchangeRate: 7})
    assert.equal(quote.displayAmount, '¥0.0014')
    await assert.rejects(service.create(identity, account, 'same', material(quote.id)), {code: 'VIDEO_UPLOAD_FAILED'})
    const db = new DatabaseSync(database)
    const row = db.prepare('SELECT data FROM video_runs').get()!
    const run = {...JSON.parse(String(row.data)), phase: 'preparing', createdAt: Date.now() - 11 * 60000}
    db.prepare('UPDATE video_runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id); db.close()
    await assert.rejects(service.status(identity, account, run.id), {code: 'VIDEO_PREPARATION_INTERRUPTED'})
  } finally {service.close(); rmSync(root, {recursive: true, force: true})}
})
