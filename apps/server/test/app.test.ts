import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from '../src/app.js'
import type { ServiceConfig } from '../src/config.js'
import type {
  AccountResolver,
  PaymentService,
  TokenVerifier,
  VerifiedIdentity,
} from '../src/types.js'

const identity: VerifiedIdentity = {
  issuer: 'https://auth.example.com/oidc',
  subject: 'user-1',
  clientId: 'client-1',
  platform: 'lingweave',
  clientType: 'web',
  scopes: ['ai:invoke'],
}

const config: ServiceConfig = {
  port: 8787,
  debugAuthLogs: false,
  corsAllowedOrigins: new Set(['https://app.example.com']),
  logtoIssuer: identity.issuer,
  logtoAudience: 'https://account.example.com',
  logtoJwksUri: 'https://auth.example.com/oidc/jwks',
  logtoRequiredScopes: ['ai:invoke'],
  logtoClientPlatforms: new Map([['client-1', {
    platform: 'lingweave',
    clientType: 'web',
    webRedirects: new Map([['https://app.example.com', {
      successUrl: 'https://app.example.com/billing/result',
      cancelUrl: 'https://app.example.com/billing/result?status=cancelled',
    }]]),
  }]]),
  logtoAdminScope: 'account:admin',
  logtoRootScope: 'account:root',
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'internal-secret',
  redisUrl: '',
  accountCacheTtlMs: 0,
  maxRequestBodyBytes: 1024,
  clientDefaultModel: 'gpt-4o-mini',
}

const verifier: TokenVerifier = {
  async verify(token) {
    assert.equal(token, 'logto-token')
    return identity
  },
}

const accounts: AccountResolver = {
  async resolve(actualIdentity) {
    assert.equal(actualIdentity, identity)
    return {
      userId: 42,
      tokenId: 7,
      platform: 'lingweave',
      apiKey: 'new-api-secret-key',
      displayName: '王仔',
      username: 'wangzai',
      email: 'wangzai@example.com',
      quota: 1000,
      quotaUsed: 100,
      tokenQuota: 0,
      tokenQuotaUsed: 200,
      tokenUnlimitedQuota: false,
      quotaDisplayType: 'CNY',
      quotaPerUnit: 500000,
      usdExchangeRate: 7,
      customCurrencySymbol: '¤',
      customCurrencyExchangeRate: 1,
    }
  },
}

test('rejects protected requests without a bearer token', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('/api/account')
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'AUTH_TOKEN_REQUIRED',
    message: 'Bearer access token is required',
  })
})

test('client-credential serves the relay key to a server-side no-Origin caller', async () => {
  const app = createApp(config, { verifier, accounts })
  // No Origin header simulates a server-to-server trusted client (python
  // requests), which the CORS middleware must not reject. The response is
  // deliberately not CORS-exposed to browsers.
  const response = await app.request('http://account.example.com/api/client-credential', {
    headers: { Authorization: 'Bearer logto-token' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('expires'), '0')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'")
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  const body = (await response.json()) as {
    success: boolean
    data: { baseUrl: string; apiKey: string; modelName: string; expiresAt: number }
  }
  assert.equal(body.success, true)
  assert.deepEqual(body.data, {
    baseUrl: 'https://new-api.example.com',
    apiKey: 'new-api-secret-key',
    modelName: 'gpt-4o-mini',
    expiresAt: 0,
  })
})

test('client-credential rejects every browser Origin, including allowlisted origins', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('http://account.example.com/api/client-credential', {
    headers: { Authorization: 'Bearer logto-token', Origin: 'https://app.example.com' },
  })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'CLIENT_CREDENTIAL_ORIGIN_FORBIDDEN',
    message: 'Client credential is not available to browsers',
  })
})

test('returns public account data without exposing the NewAPI key', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('/api/account', {
    headers: { Authorization: 'Bearer logto-token' },
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.doesNotMatch(body, /new-api-secret-key/)
  assert.deepEqual(JSON.parse(body), {
    success: true,
    data: {
      userId: 42,
      tokenId: 7,
      platform: 'lingweave',
      displayName: '王仔',
      username: 'wangzai',
      email: 'wangzai@example.com',
      quota: 1000,
      quotaUsed: 100,
      tokenQuota: 0,
      tokenQuotaUsed: 200,
      tokenUnlimitedQuota: false,
      quotaDisplayType: 'CNY',
      quotaPerUnit: 500000,
      usdExchangeRate: 7,
      customCurrencySymbol: '¤',
      customCurrencyExchangeRate: 1,
    },
  })
})

test('allows configured preflight origins and rejects other origins', async () => {
  const app = createApp(config, { verifier, accounts })
  const allowed = await app.request('/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com')
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null)

  const denied = await app.request('/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  })
  assert.equal(denied.status, 403)
})

test('allows same-origin preflight without requiring the service origin in CORS config', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('https://account.example.com/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://account.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://account.example.com')
})

test('does not treat a different HTTPS host as same-origin behind a proxy', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('http://account.example.com/healthz', {
    headers: { Origin: 'https://evil.example.com' },
  })

  assert.equal(response.status, 403)

  const malformedOrigin = await app.request('http://account.example.com/healthz', {
    headers: { Origin: 'https://account.example.com/path' },
  })
  assert.equal(malformedOrigin.status, 403)
})

test('replaces browser authorization and streams the NewAPI response', async () => {
  let upstreamAuthorization = ''
  let upstreamBody = ''
  const app = createApp(config, {
    verifier,
    accounts,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      upstreamAuthorization = request.headers.get('authorization') ?? ''
      upstreamBody = await request.text()
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        headers: {
          'Content-Type': 'text/event-stream',
          'Set-Cookie': 'should-not-leak=1',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Upstream-Secret',
          'Access-Control-Max-Age': '86400',
        },
      })
    },
  })

  const response = await app.request('/v1/chat/completions?trace=1', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      'Content-Type': 'application/json',
      Origin: 'https://app.example.com',
    },
    body: JSON.stringify({ model: 'test', stream: true }),
  })

  assert.equal(response.status, 200)
  assert.equal(upstreamAuthorization, 'Bearer new-api-secret-key')
  assert.deepEqual(JSON.parse(upstreamBody), { model: 'test', stream: true })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('access-control-expose-headers'), 'Content-Type,X-Request-Id')
  assert.doesNotMatch(response.headers.get('access-control-expose-headers') ?? '', /X-Upstream-Secret/)
  assert.equal(response.headers.get('access-control-max-age'), null)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com')
  assert.match(await response.text(), /\[DONE\]/)
})

test('enforces the configured request body limit', async () => {
  const app = createApp(config, { verifier, accounts })
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      'Content-Type': 'application/json',
      'Content-Length': '2048',
    },
    body: '{}',
  })
  assert.equal(response.status, 413)
})

test('creates a top-up through the Logto-authenticated payment facade', async () => {
  let received: { userId: number; provider: string; payload: Record<string, unknown> } | undefined
  const payments: PaymentService = {
    async getTopUpInfo() {
      return { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } }
    },
    async listTopUps() {
      return { data: { items: [] } }
    },
    async createTopUp(userId, provider, payload) {
      received = { userId, provider, payload }
      return {
        data: {
          pid: '10001',
          type: 'wxpay',
          out_trade_no: 'trade-1',
          notify_url: 'https://relay.example/notify',
          return_url: 'http://127.0.0.1:3003/billing/result',
          name: '账户充值',
          money: '10.00',
          sign: 'signature',
          pay_link: 'https://pay.example/checkout',
        },
        url: 'https://pay.example/checkout',
      }
    },
    async getSubscriptionPlans() {
      return { data: [] }
    },
    async getSubscriptionSelf() {
      return { data: {} }
    },
    async purchaseSubscription() {
      return { data: null }
    },
  }
  const app = createApp(config, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topups', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      Origin: 'https://app.example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payment_option_id: 'card', amount: 100 }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(received, {
    userId: 42,
    provider: 'stripe',
    payload: {
      amount: 100,
      payment_method: 'stripe',
      success_url: 'https://app.example.com/billing/result',
      cancel_url: 'https://app.example.com/billing/result?status=cancelled',
    },
  })
  assert.deepEqual(await response.json(), {
    success: true,
    data: {
      payment_url: 'https://pay.example/checkout',
      payment_fields: {
        pid: '10001',
        type: 'wxpay',
        out_trade_no: 'trade-1',
        notify_url: 'https://relay.example/notify',
        return_url: 'http://127.0.0.1:3003/billing/result',
        name: '账户充值',
        money: '10.00',
        sign: 'signature',
      },
      order_id: 'trade-1',
    },
  })
})

test('returns normalized top-up options from the payment facade', async () => {
  const payments: PaymentService = {
    async getTopUpInfo() {
      return {
        data: {
          enable_online_topup: true,
          pay_methods: [{ name: '微信', type: 'wxpay' }],
          amount_options: [10, 20],
        },
      }
    },
    async listTopUps() {
      return { data: { items: [] } }
    },
    async createTopUp() {
      return { data: {} }
    },
    async getSubscriptionPlans() {
      return { data: [] }
    },
    async getSubscriptionSelf() {
      return { data: {} }
    },
    async purchaseSubscription() {
      return { data: null }
    },
  }
  const app = createApp(config, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topup/info', {
    headers: { Authorization: 'Bearer logto-token' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    success: true,
    data: {
      payment_options: [{ id: 'online-wxpay', name: '微信', kind: 'amount' }],
      amount_options: [10, 20],
    },
  })
})

test('uses the client and origin payment redirect configuration', async () => {
  let receivedPayload: Record<string, unknown> | undefined
  const payments: PaymentService = {
    async getTopUpInfo() {
      return { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } }
    },
    async listTopUps() {
      return { data: {} }
    },
    async createTopUp(_userId, _provider, payload) {
      receivedPayload = payload
      return { data: { pay_link: 'https://pay.example/checkout' } }
    },
    async getSubscriptionPlans() {
      return { data: [] }
    },
    async getSubscriptionSelf() {
      return { data: {} }
    },
    async purchaseSubscription() {
      return { data: null }
    },
  }
  const app = createApp(config, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topups', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      Origin: 'https://app.example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: 100,
      payment_option_id: 'card',
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(receivedPayload, {
    amount: 100,
    payment_method: 'stripe',
    success_url: 'https://app.example.com/billing/result',
    cancel_url: 'https://app.example.com/billing/result?status=cancelled',
  })
})

test('rejects unsafe top-up payloads before calling the payment service', async () => {
  let called = false
  const payments: PaymentService = {
    async getTopUpInfo() {
      return { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } }
    },
    async listTopUps() {
      return { data: {} }
    },
    async createTopUp() {
      called = true
      return { data: {} }
    },
    async getSubscriptionPlans() {
      return { data: [] }
    },
    async getSubscriptionSelf() {
      return { data: {} }
    },
    async purchaseSubscription() {
      return { data: null }
    },
  }
  const app = createApp(config, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topups', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      Origin: 'https://app.example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payment_option_id: 'card', amount: 100_000_001 }),
  })

  assert.equal(response.status, 400)
  assert.equal(called, false)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'INVALID_PAYMENT_REQUEST',
    message: 'Invalid payment request',
  })
})

test('rejects client-supplied payment redirects', async () => {
  let called = false
  const payments: PaymentService = {
    async getTopUpInfo() {
      return { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } }
    },
    async listTopUps() { return { data: {} } },
    async createTopUp() {
      called = true
      return { data: {} }
    },
    async getSubscriptionPlans() { return { data: [] } },
    async getSubscriptionSelf() { return { data: {} } },
    async purchaseSubscription() { return { data: null } },
  }
  const app = createApp(config, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topups', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      Origin: 'https://app.example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payment_option_id: 'card',
      amount: 100,
      success_url: 'https://evil.example.com/result',
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(called, false)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'PAYMENT_REDIRECT_OVERRIDE_FORBIDDEN',
    message: 'Payment redirect is controlled by the Account Service',
  })
})

test('selects a desktop payment redirect without an Origin header', async () => {
  let receivedPayload: Record<string, unknown> | undefined
  const desktopConfig = {
    ...config,
    logtoClientPlatforms: new Map([['client-1', {
      platform: 'cqai-desktop',
      clientType: 'desktop' as const,
      webRedirects: new Map(),
      desktopRedirect: {
        successUrl: 'cqai://payment/result',
        cancelUrl: 'cqai://payment/result?status=cancelled',
      },
    }]]),
  }
  const payments: PaymentService = {
    async getTopUpInfo() {
      return { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } }
    },
    async listTopUps() { return { data: {} } },
    async createTopUp(_userId, _provider, payload) {
      receivedPayload = payload
      return { data: {} }
    },
    async getSubscriptionPlans() { return { data: [] } },
    async getSubscriptionSelf() { return { data: {} } },
    async purchaseSubscription() { return { data: null } },
  }
  const app = createApp(desktopConfig, { verifier, accounts, payments })
  const response = await app.request('/api/billing/topups', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer logto-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payment_option_id: 'card', amount: 100 }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(receivedPayload, {
    amount: 100,
    payment_method: 'stripe',
    success_url: 'cqai://payment/result',
    cancel_url: 'cqai://payment/result?status=cancelled',
  })
})
