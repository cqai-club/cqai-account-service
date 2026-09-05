import { createHash } from 'node:crypto'

import { AiAccountError, NewApiClient } from '@cqaiclub/cqai-account-sdk'

import type { AccountCache } from './cache.js'
import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'
import type { AccountResolver, ResolvedAccount, VerifiedIdentity } from './types.js'

type NewApiProvisioner = Pick<NewApiClient, 'provision'>
type AccountResolverConfig = Pick<
  ServiceConfig,
  'newApiBaseUrl' | 'newApiInternalToken' | 'accountCacheTtlMs'
>

export class NewApiAccountResolver implements AccountResolver {
  private readonly injectedClient: NewApiProvisioner | undefined

  constructor(
    private readonly config: AccountResolverConfig,
    client?: NewApiProvisioner,
    private readonly cache?: AccountCache,
  ) {
    this.injectedClient = client
  }

  async resolve(identity: VerifiedIdentity): Promise<ResolvedAccount> {
    if (!this.config.newApiBaseUrl || !this.config.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }

    const cacheKey = `${identity.issuer}\u0000${identity.subject}\u0000${identity.platform}`
    const cached = await this.cache?.get(cacheKey)
    if (this.config.accountCacheTtlMs > 0 && cached) return cached

    const client = this.injectedClient ?? new NewApiClient({
      baseUrl: this.config.newApiBaseUrl,
      serviceToken: this.config.newApiInternalToken,
    })

    try {
      const binding = await client.provision(
        {
          issuer: identity.issuer,
          subject: identity.subject,
          platform: identity.platform,
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.role === undefined ? {} : { role: identity.role }),
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
      await this.cache?.set(cacheKey, account, this.config.accountCacheTtlMs)
      return account
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof AiAccountError) {
        throw new ServiceError('NewAPI account provisioning failed', 502, safeUpstreamErrorCode(error.code))
      }
      throw new ServiceError('NewAPI account provisioning failed', 502, 'NEW_API_PROVISION_FAILED')
    }
  }
}

function safeUpstreamErrorCode(value: unknown): string {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value
  return 'NEW_API_PROVISION_FAILED'
}

function idempotencyKey(value: string): string {
  return `account-${createHash('sha256').update(value).digest('hex')}`
}
