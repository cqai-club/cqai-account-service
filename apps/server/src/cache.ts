import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

import { createClient } from 'redis'

import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'
import type { ResolvedAccount } from './types.js'

const CACHE_KEY_PREFIX = 'cqai:account-cache:v1:'
const CACHE_IV_BYTES = 12
const CACHE_TAG_BYTES = 16
const CACHE_RETRY_MS = 30_000
const CACHE_MAX_MEMORY_ENTRIES = 10_000

export interface AccountCache {
  get(key: string): Promise<ResolvedAccount | undefined>
  set(key: string, account: ResolvedAccount, ttlMs: number): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
}

export class MemoryAccountCache implements AccountCache {
  private readonly entries = new Map<string, { account: ResolvedAccount; expiresAt: number }>()

  async get(key: string): Promise<ResolvedAccount | undefined> {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.account
  }

  async set(key: string, account: ResolvedAccount, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    if (this.entries.size >= CACHE_MAX_MEMORY_ENTRIES) await this.clearExpired()
    // Defensive clone keeps callers from mutating the cached account and
    // accidentally changing the shared NewAPI key outside the cache.
    this.entries.set(key, { account: { ...account }, expiresAt: Date.now() + ttlMs })
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  async close(): Promise<void> {}

  private async clearExpired(): Promise<void> {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
    if (this.entries.size >= CACHE_MAX_MEMORY_ENTRIES) this.entries.clear()
  }
}

export class RedisAccountCache implements AccountCache {
  private readonly client
  private available = false
  private retryAfter = 0

  constructor(
    url: string,
    private readonly keyMaterial: string,
  ) {
    if (!keyMaterial) {
      throw new ServiceError('REDIS_URL requires NEW_API_INTERNAL_TOKEN', 500, 'CONFIG_INVALID')
    }
    this.client = createClient({ url })
    // The Redis client emits errors on the shared client object. Swallow them
    // here and only use fixed, secret-free fallback logs when a request needs
    // the cache; we never log connection details or cached values.
    this.client.on('error', () => undefined)
  }

  async connect(): Promise<boolean> {
    try {
      if (!this.client.isOpen) await this.client.connect()
      await this.client.ping()
      this.available = true
      this.retryAfter = 0
      return true
    } catch {
      this.markUnavailable()
      return false
    }
  }

  async get(key: string): Promise<ResolvedAccount | undefined> {
    if (!(await this.ready())) return undefined
    try {
      const raw = await this.client.get(redisKey(key))
      if (!raw) return undefined
      return decryptAccount(raw, this.keyMaterial)
    } catch {
      this.markUnavailable()
      return undefined
    }
  }

  async set(key: string, account: ResolvedAccount, ttlMs: number): Promise<void> {
    if (ttlMs <= 0 || !(await this.ready())) return
    try {
      await this.client.set(redisKey(key), encryptAccount(account, this.keyMaterial), {
        PX: Math.floor(ttlMs),
      })
    } catch {
      this.markUnavailable()
    }
  }

  async clear(): Promise<void> {
    if (!(await this.ready())) return
    try {
      // A bounded prefix scan is enough for this small control-plane cache.
      let cursor = 0
      do {
        const next = await this.client.scan(cursor, { MATCH: `${CACHE_KEY_PREFIX}*`, COUNT: 200 })
        cursor = Number(next.cursor)
        if (next.keys.length > 0) await this.client.del(next.keys)
      } while (cursor !== 0)
    } catch {
      this.markUnavailable()
    }
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
  }

  private async ready(): Promise<boolean> {
    if (this.available) return true
    if (Date.now() < this.retryAfter) return false
    return this.connect()
  }

  private markUnavailable(): void {
    this.available = false
    this.retryAfter = Date.now() + CACHE_RETRY_MS
  }
}

/** Resolve the cache backend from the static bootstrap configuration. */
export async function createAccountCache(
  config: Pick<ServiceConfig, 'redisUrl' | 'newApiInternalToken' | 'accountCacheTtlMs'>,
): Promise<AccountCache> {
  if (!config.redisUrl) return new MemoryAccountCache()
  const memory = new MemoryAccountCache()
  const redis = new RedisAccountCache(config.redisUrl, config.newApiInternalToken)
  const connected = await redis.connect()
  // The in-memory cache always remains a safe fallback if Redis is temporarily
  // down or misconfigured; business requests must not fail because the cache
  // is. The Redis layer will retry with a bounded backoff on later requests.
  if (!connected) console.warn('Account cache Redis unavailable; using in-memory fallback')
  return new HybridAccountCache(memory, redis, config.accountCacheTtlMs)
}

/**
 * Always keeps a process-local copy so a later Redis outage does not turn
 * every request into a NewAPI provisioning call. When Redis is configured,
 * both layers are written; reads prefer the fast local copy and fall back to
 * the encrypted remote value.
 */
class HybridAccountCache implements AccountCache {
  private readonly ttlMs: number

  constructor(
    private readonly memory: MemoryAccountCache,
    private readonly redis: RedisAccountCache,
    ttlMs: number,
  ) {
    this.ttlMs = ttlMs
  }

  async get(key: string): Promise<ResolvedAccount | undefined> {
    const local = await this.memory.get(key)
    if (local) return local
    const remote = await this.redis.get(key)
    if (!remote) return undefined
    if (this.ttlMs > 0) await this.memory.set(key, remote, this.ttlMs)
    return remote
  }

  async set(key: string, account: ResolvedAccount, ttlMs: number): Promise<void> {
    // Memory write must happen even if Redis is down so local requests keep
    // working and the resolver does not provision again on every call.
    await this.memory.set(key, account, ttlMs)
    await this.redis.set(key, account, ttlMs).catch(() => undefined)
  }

  async clear(): Promise<void> {
    await this.memory.clear()
    await this.redis.clear()
  }

  async close(): Promise<void> {
    await this.memory.close()
    await this.redis.close()
  }
}

export function encryptAccount(account: ResolvedAccount, keyMaterial: string): string {
  const plaintext = Buffer.from(JSON.stringify(account), 'utf8')
  const key = cacheKey(keyMaterial)
  const iv = randomBytes(CACHE_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptAccount(raw: string, keyMaterial: string): ResolvedAccount {
  const parts = raw.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid encrypted cache payload')
  const iv = Buffer.from(parts[1]!, 'base64url')
  const tag = Buffer.from(parts[2]!, 'base64url')
  const ciphertext = Buffer.from(parts[3]!, 'base64url')
  if (iv.length !== CACHE_IV_BYTES || tag.length !== CACHE_TAG_BYTES) throw new Error('invalid encrypted cache payload')
  const decipher = createDecipheriv('aes-256-gcm', cacheKey(keyMaterial), iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const value = JSON.parse(plaintext.toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || typeof (value as ResolvedAccount).apiKey !== 'string') {
    throw new Error('invalid encrypted cache payload')
  }
  return value as ResolvedAccount
}

function cacheKey(keyMaterial: string): Buffer {
  return createHash('sha256').update('cqai-account-cache-v1\0').update(keyMaterial).digest()
}

function redisKey(key: string): string {
  return `${CACHE_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`
}
