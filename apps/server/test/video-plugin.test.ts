import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

test('Relay adapter validates account signatures, preserves upstream idempotency, and meters actual duration', () => {
  const source = readFileSync(new URL('../../../integrations/relay/ejianbao.plugin.js', import.meta.url), 'utf8')
  const plugin = runInNewContext(source.replaceAll('export ', '') + '\n({buildSubmitRequest,extractUsage,extractUsageOnComplete,buildContentRequest})', {utils: {hmacSHA256: (text: string, key: string) => createHmac('sha256', key).update(text).digest('hex')}})
  const envelope = JSON.stringify({avatar_id: 'a1', voice_id: 'v1', request_id: 'local1', script_text: '测试', seconds: 20})
  const ctx = {apiKey: 'platform-secret', baseUrl: 'https://vendor.test/openapi/v1', requestBody: {envelope, signature: createHmac('sha256', 'platform-secret').update(envelope).digest('hex')}}
  assert.equal(plugin.extractUsage(ctx).seconds, 20)
  assert.equal(plugin.buildSubmitRequest(ctx).headers['Idempotency-Key'], 'local1')
  assert.equal(plugin.extractUsageOnComplete({}, {status: 'SUCCESS'}, {outputs: [{name: 'video', duration_seconds: 13.2}]}).seconds, 14)
  assert.equal(plugin.extractUsageOnComplete({}, {status: 'SUCCESS'}, {outputs: [{name: 'video', duration_seconds: 3.66}]}).seconds, 10)
  assert.throws(() => plugin.extractUsage({...ctx, requestBody: {envelope, signature: 'fake'}}))
  assert.throws(() => plugin.extractUsageOnComplete({}, {status: 'SUCCESS'}, {outputs: [{name: 'video', duration_seconds: 1e99}]}))
  assert.throws(() => plugin.buildContentRequest({...ctx, artifactKey: 'video', upstreamTaskId: '../private'}))
})
