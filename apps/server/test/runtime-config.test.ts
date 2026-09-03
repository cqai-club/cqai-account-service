import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ServiceConfig } from '../src/config.js'
import { ServiceError } from '../src/errors.js'
import {
  RuntimeConfigStore,
  runtimeConfigStorePath,
} from '../src/runtime-config.js'

const baseConfig: ServiceConfig = {
  port: 8787,
  corsAllowedOrigins: new Set(['https://app.example.com']),
  logtoIssuer: 'https://auth.example.com/oidc',
  logtoAudience: 'https://account.example.com',
  logtoJwksUri: 'https://auth.example.com/oidc/jwks',
  logtoRequiredScopes: ['ai:invoke'],
  logtoClientPlatforms: new Map([['client-1', 'lingweave']]),
  logtoAdminClientId: 'admin-client',
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'do-not-persist-this-token',
  accountCacheTtlMs: 300_000,
  maxRequestBodyBytes: 20_971_520,
}

test('exposes a defensive, secret-free public configuration', async () => {
  const store = new RuntimeConfigStore(baseConfig, {
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  })

  const publicConfig = store.getPublicConfig()
  assert.deepEqual(publicConfig, {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    corsAllowedOrigins: ['https://app.example.com'],
    logtoRequiredScopes: ['ai:invoke'],
    logtoClientPlatforms: { 'client-1': 'lingweave' },
    accountCacheTtlSeconds: 300,
    maxRequestBodyBytes: 20_971_520,
    newApiBaseUrl: 'https://new-api.example.com',
    persistence: { enabled: false },
  })
  assert.doesNotMatch(JSON.stringify(publicConfig), /do-not-persist-this-token/)

  const snapshot = store.getSnapshot()
  ;(snapshot.corsAllowedOrigins as Set<string>).add('https://mutated.example.com')
  ;(snapshot.logtoRequiredScopes as string[]).push('mutated')
  ;(snapshot.logtoClientPlatforms as Map<string, string>).set('client-2', 'other')
  assert.deepEqual(store.getPublicConfig().corsAllowedOrigins, ['https://app.example.com'])
  assert.deepEqual(store.getPublicConfig().logtoRequiredScopes, ['ai:invoke'])
  assert.deepEqual(store.getPublicConfig().logtoClientPlatforms, { 'client-1': 'lingweave' })
})

test('updates only allowlisted fields and enforces optimistic versions', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z')
  const store = new RuntimeConfigStore(baseConfig, { clock: () => now })
  now = new Date('2026-01-01T00:00:01.000Z')

  const updated = await store.update(
    {
      corsAllowedOrigins: ['https://app.example.com', 'http://localhost:3000/'],
      logtoRequiredScopes: 'openid ai:invoke',
      logtoClientPlatforms: { 'client-1': 'lingweave', 'client-2': 'image-app' },
      accountCacheTtlSeconds: 30,
      maxRequestBodyBytes: 1024,
    },
    1,
  )
  assert.equal(updated.version, 2)
  assert.equal(updated.updatedAt, '2026-01-01T00:00:01.000Z')
  assert.equal(updated.accountCacheTtlMs, 30_000)
  assert.deepEqual([...updated.corsAllowedOrigins], ['https://app.example.com', 'http://localhost:3000'])
  assert.deepEqual([...updated.logtoRequiredScopes], ['openid', 'ai:invoke'])
  assert.deepEqual(Object.fromEntries(updated.logtoClientPlatforms), {
    'client-1': 'lingweave',
    'client-2': 'image-app',
  })
  assert.equal(store.getConfig().newApiInternalToken, baseConfig.newApiInternalToken)

  await assert.rejects(
    () => store.update({ maxRequestBodyBytes: 2048 }, 1),
    (error: unknown) => error instanceof ServiceError
      && error.status === 409
      && error.code === 'CONFIG_VERSION_CONFLICT',
  )
  const baseUrlUpdated = await store.update({ newApiBaseUrl: 'https://new-api-2.example.com' }, 2)
  assert.equal(baseUrlUpdated.newApiBaseUrl, 'https://new-api-2.example.com')
  await assert.rejects(
    () => store.update({ accountCacheTtlMs: 1 }),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.code === 'CONFIG_PATCH_INVALID',
  )
  await assert.rejects(
    () => store.update({ logtoClientPlatforms: { 'client-1': 'admin' } }),
    (error: unknown) => error instanceof ServiceError && error.code === 'CONFIG_PATCH_INVALID',
  )
})

test('serializes concurrent updates and checks versions at commit time', async () => {
  const store = new RuntimeConfigStore(baseConfig)
  const first = store.update({ maxRequestBodyBytes: 1024 }, 1)
  const second = store.update({ maxRequestBodyBytes: 2048 }, 1)
  const firstResult = await first
  assert.equal(firstResult.version, 2)
  await assert.rejects(
    () => second,
    (error: unknown) => error instanceof ServiceError && error.code === 'CONFIG_VERSION_CONFLICT',
  )
  assert.equal(store.getSnapshot().maxRequestBodyBytes, 1024)
})

test('allows clearing dynamic CORS and client mappings', async () => {
  const store = new RuntimeConfigStore(baseConfig)
  const updated = await store.update({ corsAllowedOrigins: [], logtoClientPlatforms: {} }, 1)
  assert.deepEqual([...updated.corsAllowedOrigins], [])
  assert.deepEqual([...updated.logtoClientPlatforms], [])
  assert.deepEqual(store.getPublicConfig().corsAllowedOrigins, [])
  assert.deepEqual(store.getPublicConfig().logtoClientPlatforms, {})
})

test('persists safe fields with atomic replacement and restores them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cqai-runtime-config-'))
  const path = join(directory, 'nested', 'runtime.json')
  try {
    const first = new RuntimeConfigStore(baseConfig, {
      path,
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    })
    await first.load()
    assert.equal(first.isLoaded(), true)
    await first.update({
      corsAllowedOrigins: ['https://admin.example.com'],
      accountCacheTtlSeconds: 42,
    }, 1)

    const raw = await fs.readFile(path, 'utf8')
    const persisted = JSON.parse(raw) as Record<string, unknown>
    assert.equal(persisted.schemaVersion, 1)
    assert.equal(persisted.version, 2)
    assert.equal(persisted.accountCacheTtlSeconds, 42)
    assert.equal('newApiInternalToken' in persisted, false)
    assert.doesNotMatch(raw, /do-not-persist-this-token/)

    const restored = await RuntimeConfigStore.fromConfig(baseConfig, {
      path,
      clock: () => new Date('2026-01-02T00:00:00.000Z'),
    })
    assert.deepEqual(restored.getPublicConfig(), {
      version: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      corsAllowedOrigins: ['https://admin.example.com'],
      logtoRequiredScopes: ['ai:invoke'],
      logtoClientPlatforms: { 'client-1': 'lingweave' },
      accountCacheTtlSeconds: 42,
      maxRequestBodyBytes: 20_971_520,
      newApiBaseUrl: 'https://new-api.example.com',
      persistence: { enabled: true },
    })
    assert.equal(restored.getConfig().newApiInternalToken, baseConfig.newApiInternalToken)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('fails closed on malformed persisted configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cqai-runtime-config-invalid-'))
  const path = join(directory, 'runtime.json')
  try {
    await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, version: 1 }), 'utf8')
    const store = new RuntimeConfigStore(baseConfig, { path })
    await assert.rejects(
      () => store.load(),
      (error: unknown) => error instanceof ServiceError
        && error.status === 500
        && error.code === 'CONFIG_STORE_INVALID',
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('resolves CONFIG_STORE_PATH and keeps empty values in memory', () => {
  assert.equal(runtimeConfigStorePath({ CONFIG_STORE_PATH: '' }), undefined)
  assert.equal(runtimeConfigStorePath({ CONFIG_STORE_PATH: 'runtime/config.json' }), resolvePath('runtime/config.json'))
})

function resolvePath(value: string): string {
  return join(process.cwd(), value)
}
