import { createHash } from 'node:crypto'

import { AiAccountError, NewApiClient } from '@cqaiclub/cqai-account-sdk'

import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'
import type { RuntimeConfigStore } from './runtime-config.js'
import type { AccountResolver, ResolvedAccount, VerifiedIdentity } from './types.js'

interface CacheEntry {
  createdAt: number
  expiresAt: number
  account: ResolvedAccount
}

type NewApiProvisioner = Pick<NewApiClient, 'provision'>
type AccountResolverConfig = Pick<
  ServiceConfig,
  'newApiBaseUrl' | 'newApiInternalToken' | 'accountCacheTtlMs'
>

export class NewApiAccountResolver implements AccountResolver {
  private readonly injectedClient: NewApiProvisioner | undefined
  private readonly cache = new Map<string, CacheEntry>()
  private lastCacheTtlMs: number | undefined
  private lastNewApiBaseUrl: string | undefined

  constructor(
    private readonly config: AccountResolverConfig,
    client?: NewApiProvisioner,
    private readonly runtimeConfig?: Pick<RuntimeConfigStore, 'getSnapshot' | 'getConfig'>,
  ) {
    this.injectedClient = client
  }

  async resolve(identity: VerifiedIdentity): Promise<ResolvedAccount> {
    const cacheKey = `${identity.issuer}\u0000${identity.subject}\u0000${identity.platform}`
    const activeConfig = this.runtimeConfig?.getConfig?.() ?? this.config
    if (!activeConfig.newApiBaseUrl || !activeConfig.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }
    const client = this.injectedClient ?? new NewApiClient({
      baseUrl: activeConfig.newApiBaseUrl,
      serviceToken: activeConfig.newApiInternalToken,
    })
    const accountCacheTtlMs = activeConfig.accountCacheTtlMs
    if ((this.lastCacheTtlMs !== undefined && this.lastCacheTtlMs !== accountCacheTtlMs)
      || (this.lastNewApiBaseUrl !== undefined && this.lastNewApiBaseUrl !== activeConfig.newApiBaseUrl)) {
      // Do not retain keys under an obsolete cache policy after an admin
      // changes the TTL (including disabling the cache).
      this.cache.clear()
    }
    this.lastCacheTtlMs = accountCacheTtlMs
    this.lastNewApiBaseUrl = activeConfig.newApiBaseUrl
    const cached = this.cache.get(cacheKey)
    const now = Date.now()
    if (accountCacheTtlMs > 0 && cached && cached.createdAt + accountCacheTtlMs > now && cached.expiresAt > now) {
      return cached.account
    }
    if (accountCacheTtlMs <= 0) this.cache.delete(cacheKey)

    try {
      const binding = await client.provision(
        {
          issuer: identity.issuer,
          subject: identity.subject,
          platform: identity.platform,
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.name ? { name: identity.name } : {}),
        },
        { idempotencyKey: idempotencyKey(cacheKey) },
      )
      const apiKey = binding.apiKey ?? binding.key ?? binding.token
      if (!apiKey) {
        throw new ServiceError('NewAPI did not return a usable relay key', 502, 'NEW_API_KEY_UNAVAILABLE')
      }
      const account: ResolvedAccount = {
        userId: binding.userId,
        platform: identity.platform,
        apiKey,
        ...(binding.tokenId === undefined ? {} : { tokenId: binding.tokenId }),
        ...(binding.quota === undefined ? {} : { quota: binding.quota }),
        ...(binding.quotaUsed === undefined ? {} : { quotaUsed: binding.quotaUsed }),
      }
      if (accountCacheTtlMs > 0) {
        if (this.cache.size >= 10_000) this.removeExpiredEntries()
        const createdAt = Date.now()
        this.cache.set(cacheKey, { account, createdAt, expiresAt: createdAt + accountCacheTtlMs })
      }
      return account
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof AiAccountError) {
        throw new ServiceError('NewAPI account provisioning failed', 502, safeUpstreamErrorCode(error.code))
      }
      throw new ServiceError('NewAPI account provisioning failed', 502, 'NEW_API_PROVISION_FAILED')
    }
  }

  private removeExpiredEntries(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key)
    }
    if (this.cache.size >= 10_000) this.cache.clear()
  }
}

function safeUpstreamErrorCode(value: unknown): string {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value
  return 'NEW_API_PROVISION_FAILED'
}

function idempotencyKey(value: string): string {
  return `account-${createHash('sha256').update(value).digest('hex')}`
}
