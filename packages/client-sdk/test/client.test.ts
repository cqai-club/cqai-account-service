import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountClientError, CqaiAccountClient } from '../src/index.js'

test('adds the current Logto token without browser credentials', async () => {
  let captured: Request | undefined
  const client = new CqaiAccountClient({
    baseUrl: 'https://account.example.com',
    getAccessToken: async () => 'logto-token',
    fetch: async (input, init) => {
      captured = new Request(input, init)
      return Response.json({ success: true, data: { userId: 1, platform: 'lingweave' } })
    },
  })

  const account = await client.getAccount()
  assert.deepEqual(account, { userId: 1, platform: 'lingweave' })
  assert.equal(captured?.headers.get('authorization'), 'Bearer logto-token')
  assert.equal(captured?.credentials, 'omit')
})

test('returns the raw response for streaming AI calls', async () => {
  const client = new CqaiAccountClient({
    baseUrl: 'https://account.example.com/',
    getAccessToken: () => 'logto-token',
    fetch: async () => new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  })
  const response = await client.createChatCompletion({ model: 'test', stream: true })
  assert.equal(await response.text(), 'data: hello\n\n')
})

test('reports non-JSON account responses without parsing HTML as JSON', async () => {
  const client = new CqaiAccountClient({
    baseUrl: 'https://account.example.com',
    getAccessToken: () => 'logto-token',
    fetch: async () => new Response('<!doctype html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
  })
  await assert.rejects(() => client.getAccount(), (error: unknown) => {
    assert.ok(error instanceof AccountClientError)
    assert.match(error.message, /non-JSON response/)
    return true
  })
})
