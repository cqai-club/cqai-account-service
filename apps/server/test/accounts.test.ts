import assert from 'node:assert/strict'
import test from 'node:test'

import { NewApiAccountResolver } from '../src/accounts.js'
import { MemoryAccountCache } from '../src/cache.js'
import { ServiceError } from '../src/errors.js'
import type { VerifiedIdentity } from '../src/types.js'
import { AiAccountError } from '@cqaiclub/cqai-account-sdk'

const config = {
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'internal-token',
  accountCacheTtlMs: 60_000,
}

const identity: VerifiedIdentity = {
  issuer: 'https://auth.example.com/oidc',
  subject: 'user-1',
  clientId: 'client-1',
  platform: 'lingweave',
  scopes: ['ai:invoke'],
  email: 'user@example.com',
  username: 'logto-user',
  role: 10,
}

test('provisions once and keeps the NewAPI key only in the resolved server account', async () => {
  let calls = 0
  let receivedIdempotencyKey = ''
  const resolver = new NewApiAccountResolver(
    config,
    {
      async provision(request, options) {
        calls += 1
        assert.deepEqual(request, {
          issuer: identity.issuer,
          subject: identity.subject,
          platform: identity.platform,
          email: identity.email,
          username: identity.username,
          role: identity.role,
        })
        receivedIdempotencyKey = options?.idempotencyKey ?? ''
        return { userId: 42, tokenId: 7, apiKey: 'sk-secret' }
      },
    },
    new MemoryAccountCache(),
  )

  const first = await resolver.resolve(identity)
  const second = await resolver.resolve(identity)
  assert.equal(calls, 1)
  assert.deepEqual(first, second)
  assert.equal(first.apiKey, 'sk-secret')
  assert.match(receivedIdempotencyKey, /^account-[a-f0-9]{64}$/)
})

test('falls back to provisioning when the cache is disabled', async () => {
  let calls = 0
  const resolver = new NewApiAccountResolver(
    { ...config, accountCacheTtlMs: 0 },
    {
      async provision() {
        calls += 1
        return { userId: 42, tokenId: 7, apiKey: 'sk-secret' }
      },
    },
    new MemoryAccountCache(),
  )
  await resolver.resolve(identity)
  await resolver.resolve(identity)
  assert.equal(calls, 2)
})

test('fails closed when provisioning does not return a relay key', async () => {
  const resolver = new NewApiAccountResolver(config, {
    async provision() {
      return { userId: 42, tokenId: 7 }
    },
  })
  await assert.rejects(
    () => resolver.resolve(identity),
    (error: unknown) => error instanceof ServiceError && error.code === 'NEW_API_KEY_UNAVAILABLE',
  )
})

test('does not reflect arbitrary upstream error codes in client responses', async () => {
  const resolver = new NewApiAccountResolver(config, {
    async provision() {
      throw new AiAccountError('upstream details', 502, 'SECRET-sk-key')
    },
  })
  await assert.rejects(
    () => resolver.resolve(identity),
    (error: unknown) => error instanceof ServiceError
      && error.code === 'NEW_API_PROVISION_FAILED'
      && !error.message.includes('upstream details'),
  )
})

test('uses verified Logto claims without calling the UserInfo endpoint', async () => {
  let provisionCalls = 0
  const resolver = new NewApiAccountResolver(
    { ...config, accountCacheTtlMs: 0 },
    {
      async provision(request) {
        provisionCalls += 1
        assert.equal(request.username, identity.username)
        assert.equal(request.name, identity.name)
        assert.equal(request.email, identity.email)
        return { userId: 42, tokenId: 7, apiKey: 'sk-secret', userCreated: true }
      },
    },
  )

  await resolver.resolve(identity)

  assert.equal(provisionCalls, 1)
})

test('reuses an existing NewAPI account without profile synchronization', async () => {
  let provisionCalls = 0
  const resolver = new NewApiAccountResolver(
    { ...config, accountCacheTtlMs: 0 },
    {
      async provision() {
        provisionCalls += 1
        return { userId: 42, tokenId: 7, apiKey: 'sk-secret', userCreated: false }
      },
    },
  )

  await resolver.resolve({
    ...identity,
  })
  assert.equal(provisionCalls, 1)
})
