import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from '../src/app.js'
import type { ServiceConfig } from '../src/config.js'
import type { AccountResolver, TokenVerifier, VerifiedIdentity } from '../src/types.js'

const identity: VerifiedIdentity = {
  issuer: 'https://auth.example.com/oidc',
  subject: 'user-1',
  clientId: 'client-1',
  platform: 'lingweave',
  scopes: ['ai:invoke'],
}

const config: ServiceConfig = {
  port: 8787,
  corsAllowedOrigins: new Set(['https://app.example.com']),
  logtoIssuer: identity.issuer,
  logtoAudience: 'https://account.example.com',
  logtoJwksUri: 'https://auth.example.com/oidc/jwks',
  logtoRequiredScopes: ['ai:invoke'],
  logtoClientPlatforms: new Map([['client-1', 'lingweave']]),
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'internal-secret',
  accountCacheTtlMs: 0,
  maxRequestBodyBytes: 1024,
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
      quota: 1000,
      quotaUsed: 100,
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
      quota: 1000,
      quotaUsed: 100,
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
