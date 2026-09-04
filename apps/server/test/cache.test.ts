import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryAccountCache, decryptAccount, encryptAccount } from '../src/cache.js'
import type { ResolvedAccount } from '../src/types.js'

const account: ResolvedAccount = {
  userId: 42,
  tokenId: 7,
  platform: 'lingweave',
  apiKey: 'sk-cache-secret',
  quota: 1000,
  quotaUsed: 100,
}

test('round-trips an encrypted account without exposing the API key', () => {
  const encrypted = encryptAccount(account, 'cache-key-material')
  assert.doesNotMatch(encrypted, /sk-cache-secret/)
  assert.doesNotMatch(encrypted, /"apiKey"/)
  assert.deepEqual(decryptAccount(encrypted, 'cache-key-material'), account)
})

test('does not decrypt with a different key material', () => {
  const encrypted = encryptAccount(account, 'first-key')
  assert.throws(() => decryptAccount(encrypted, 'second-key'))
})

test('rejects a malformed encrypted payload', () => {
  assert.throws(() => decryptAccount('v1.bad', 'cache-key-material'))
})

test('memory cache honors TTL and clears expired entries', async () => {
  const cache = new MemoryAccountCache()
  await cache.set('key', account, 5)
  assert.deepEqual(await cache.get('key'), account)
  // TTL is measured from insertion, so use a very short real expiration.
  await cache.set('key', account, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(await cache.get('key'), undefined)
  await cache.set('key', account, 1_000)
  assert.equal(cache.size, 1)
  await cache.clear()
  assert.equal(cache.size, 0)
})
