/** Local integration check: real JWT, HTTP, SQLite, Python and renderer; fixture cloud/Relay. */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import { createApp } from '../apps/server/src/app.js'
import { loadConfig } from '../apps/server/src/config.js'
import { LogtoTokenVerifier } from '../apps/server/src/logto.js'
import { VideoService } from '../apps/server/src/video.js'

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]!}
const desktop = resolve(option('--desktop-root', '../ebao-studio'))
const fixture = readFileSync(resolve(option('--fixture-video', join(desktop, '.build/ejianbao-verify/inputs/video.mp4'))))
const pluginRoot = join(desktop, 'cqai-dsh-plugins/cqai-dsh-plugin-video')
const {JobStore} = await import(pathToFileURL(join(pluginRoot, 'src/jobs.ts')).href)
const {ManagedJobs} = await import(pathToFileURL(join(pluginRoot, 'src/managed-jobs.ts')).href)
mkdirSync('.build', {recursive: true})
const output = mkdtempSync(resolve('.build/managed-video-'))
const source = readFileSync(new URL('../integrations/relay/ejianbao.plugin.js', import.meta.url), 'utf8')
const adapter = runInNewContext(source.replaceAll('export ', '') + '\n({buildSubmitRequest,parseSubmitResponse,parseTaskResult,extractUsage,extractUsageOnComplete,buildContentRequest})', {
  utils: {hmacSHA256: (value: string, key: string) => createHmac('sha256', key).update(value).digest('hex')},
})
let submits = 0; let uploads = 0; let downloads = 0
const testKey = 'fixture-platform-key-not-a-real-credential'
const request: typeof fetch = async (url, init) => {
  const path = String(url)
  if (path.includes('/digital-human/')) {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + testKey)
    uploads++
    return Response.json(path.endsWith('avatars') ? {avatar_id: 'fixture-avatar'} : {voice_id: 'fixture-voice'})
  }
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-relay-key')
  const context = {apiKey: testKey, baseUrl: 'https://fixture.invalid/openapi/v1'}
  if (path.endsWith('/v1/tasks/ejianbao')) {
    const ctx = {...context, requestBody: JSON.parse(String(init?.body))}
    const upstream = adapter.buildSubmitRequest(ctx)
    assert.equal(upstream.body.inputs.script_text, '这是产品账户视频服务的本地链路测试。')
    assert.ok(upstream.headers['Idempotency-Key'])
    assert.ok(adapter.extractUsage(ctx).seconds >= 10)
    assert.equal(adapter.parseSubmitResponse(ctx, {statusCode: 200, body: {run_id: 'fixture-run'}}).taskId, 'fixture-run')
    submits++; return Response.json({task_id: 'fixture-task'})
  }
  if (path.endsWith('/artifacts/video/content')) {
    assert.equal(adapter.buildContentRequest({...context, artifactKey: 'video', upstreamTaskId: 'fixture-run'}).url,
      'https://fixture.invalid/openapi/v1/runs/fixture-run/outputs/video/download')
    downloads++; return new Response(fixture, {headers: {'content-type': 'video/mp4'}})
  }
  const body = {status: 'completed', progress_percent: 100, outputs: [{name: 'video', duration_seconds: 6}]}
  const parsed = adapter.parseTaskResult({}, body)
  assert.equal(adapter.extractUsageOnComplete({}, parsed, body).seconds, 10)
  return Response.json({task_id: 'fixture-task', ...parsed})
}
const video = new VideoService({database: join(output, 'video.sqlite'), inferflowUrl: 'https://fixture.invalid/openapi/v1', inferflowKey: testKey,
  relayUrl: 'https://relay.invalid', quotaPerSecond: 10, maxUploadBytes: 1024}, request)
const config = loadConfig({LOGTO_ISSUER: 'https://issuer.invalid/oidc', LOGTO_AUDIENCE: 'https://account.invalid',
  LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({'client-1': {platform: 'desktop', client_type: 'desktop', redirects: {success_url: 'ejbtest://billing/result'}}})})
const {privateKey, publicKey} = await generateKeyPair('ES384')
const jwk = {...await exportJWK(publicKey), kid: 'fixture-key', alg: 'ES384'}
const token = await new SignJWT({client_id: 'client-1', scope: 'openid ai:invoke'}).setProtectedHeader({alg: 'ES384', kid: 'fixture-key'})
  .setSubject('fixture-user').setIssuer(config.logtoIssuer).setAudience(config.logtoAudience).setIssuedAt().setExpirationTime('1h').sign(privateKey)
const account = {userId: 1, platform: 'desktop', apiKey: 'fixture-relay-key', quota: 100000}
const app = createApp(config, {video, verifier: new LogtoTokenVerifier(config, createLocalJWKSet({keys: [jwk]})), accounts: {resolve: async () => account}})
const server = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0})
await new Promise<void>(done => server.once('listening', done))
const address = server.address(); assert.ok(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const store = new JobStore(join(output, 'jobs'), join(pluginRoot, 'runtime'), option('--python', process.env.EJIANBAO_PYTHON || 'python'))
const managed = new ManagedJobs(store, {getAccount: async () => ({userId: 1}), fetchAi: (path: string, init: RequestInit, signal?: AbortSignal) => {
  const headers = new Headers(init.headers); headers.set('authorization', 'Bearer ' + token)
  return fetch(origin + path, {...init, headers, signal})
}})
store.managedGenerate = (job: unknown, signal: AbortSignal) => managed.generate(job, signal)
try {
  assert.equal((await fetch(origin + '/v1/ejianbao/quotes', {method: 'POST', body: '{}'})).status, 401)
  const job = store.create({title: '产品账户链路测试', text: '这是产品账户视频服务的本地链路测试。', mode: 'digitalhuman', duration: 6, optimize: false, covers: false, studio: false})
  const dir = store.dir(job.id)
  writeFileSync(join(dir, 'avatar.png'), Buffer.from([137,80,78,71,13,10,26,10,0]))
  writeFileSync(join(dir, 'voice.m4a'), '0000ftypM4A fixture')
  job.uploads = {avatar: {name: 'avatar.png', file: 'avatar.png', size: 9}, voice: {name: 'voice.m4a', file: 'voice.m4a', size: 18}}
  store.save(job)
  await managed.quote(job.id)
  assert.equal(job.status, 'draft'); assert.ok(job.cloud?.quote); assert.equal(submits, 0)
  store.start(job.id)
  const deadline = Date.now() + 5 * 60000
  while (job.status === 'running' && Date.now() < deadline) await delay(500)
  assert.equal(job.status, 'completed', JSON.stringify({error: job.error, logs: job.logs.slice(-12)}))
  assert.equal(submits, 1); assert.equal(uploads, 2); assert.equal(downloads, 1)
  assert.ok(statSync(join(dir, 'final_video.mp4')).size > 1000)
  assert.doesNotMatch(JSON.stringify(job), /fixture-platform-key|fixture-relay-key|eyJhbG/)
  const report = {status: 'passed', scope: 'Real JWT + HTTP + SQLite + desktop Host + Python stdin bridge + Remotion render; fixture upstream, no real debit',
    jobId: job.id, submits, uploads, downloads, finalVideo: join(dir, 'final_video.mp4')}
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await store.dispose()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  video.close()
}
