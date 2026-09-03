import assert from 'node:assert/strict'
import test from 'node:test'

import { RuntimeConfigStore } from '../src/runtime-config.js'
import type { ServiceConfig } from '../src/config.js'

const config: ServiceConfig = {
  port: 8787,
  corsAllowedOrigins: new Set(['https://admin.example.com']),
  logtoIssuer: 'https://auth.example.com/oidc',
  logtoAudience: 'https://account.example.com',
  logtoJwksUri: 'https://auth.example.com/oidc/jwks',
  logtoRequiredScopes: ['ai:invoke'],
  logtoClientPlatforms: new Map([['customer-client', 'lingweave']]),
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'super-secret-new-api-token',
  accountCacheTtlMs: 300_000,
  maxRequestBodyBytes: 20_971_520,
}

test('the public runtime configuration never exposes bootstrap credentials', async () => {
  const store = new RuntimeConfigStore(config)
  const initial = store.getPublicConfig()
  const initialJson = JSON.stringify(initial)

  assert.doesNotMatch(initialJson, /super-secret-new-api-token/)
  assert.equal('newApiInternalToken' in initial, false)
  assert.equal(initial.newApiBaseUrl, 'https://new-api.example.com')

  const updated = await store.update({ accountCacheTtlSeconds: 60 })
  const updatedJson = JSON.stringify(store.getPublicConfig())
  assert.equal(updated.accountCacheTtlMs, 60_000)
  assert.doesNotMatch(updatedJson, /super-secret-new-api-token/)
  assert.equal('newApiInternalToken' in store.getPublicConfig(), false)
})
