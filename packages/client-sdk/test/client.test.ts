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

test('uses the Logto token for billing and never sends browser credentials', async () => {
  const captured: Request[] = []
  const client = new CqaiAccountClient({
    baseUrl: 'https://account.example.com',
    getAccessToken: () => 'logto-token',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      captured.push(request)
      return Response.json({
        success: true,
        data: { order_id: 'order-1', checkout_url: 'https://pay.example/checkout' },
      })
    },
  })

  const result = await client.createTopUp({ payment_option_id: 'card', amount: 100 })
  assert.deepEqual(result.data, { order_id: 'order-1', checkout_url: 'https://pay.example/checkout' })
  assert.equal(captured[0]?.url, 'https://account.example.com/api/billing/topups')
  assert.equal(captured[0]?.headers.get('authorization'), 'Bearer logto-token')
  assert.equal(captured[0]?.credentials, 'omit')
  assert.equal(captured[0]?.headers.get('cookie'), null)
  assert.deepEqual(JSON.parse(await captured[0]!.text()), { payment_option_id: 'card', amount: 100 })
})

test('lists only the authenticated user top-up history endpoint', async () => {
  let captured: Request | undefined
  const client = new CqaiAccountClient({
    baseUrl: 'https://account.example.com',
    getAccessToken: () => 'logto-token',
    fetch: async (input, init) => {
      captured = new Request(input, init)
      return Response.json({ success: true, data: { items: [] } })
    },
  })

  assert.deepEqual(await client.listTopUps({ page: 1, pageSize: 10 }), { items: [] })
  assert.equal(captured?.url, 'https://account.example.com/api/billing/topups?page=1&page_size=10')
  assert.equal(captured?.headers.get('authorization'), 'Bearer logto-token')
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
