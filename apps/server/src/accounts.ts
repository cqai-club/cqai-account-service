import { createHash } from 'node:crypto'

import { AiAccountError, NewApiClient } from '@cqaiclub/cqai-account-sdk'

import type { AccountCache } from './cache.js'
import type { ServiceConfig } from './config.js'
import { debugLog, fingerprintForLog, safeErrorMetadata } from './diagnostics.js'
import { ServiceError } from './errors.js'
import type { AccountResolver, ResolvedAccount, VerifiedIdentity } from './types.js'

type NewApiProvisioner = Pick<NewApiClient, 'provision'>
type AccountResolverConfig = Pick<
  ServiceConfig,
  'newApiBaseUrl' | 'newApiInternalToken' | 'accountCacheTtlMs' | 'debugAuthLogs'
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
    const startedAt = Date.now()
    debugLog(this.config.debugAuthLogs, 'account.resolve_started', {
      subjectHash: fingerprintForLog(identity.subject),
      clientId: identity.clientId,
      platform: identity.platform,
    })
    if (!this.config.newApiBaseUrl || !this.config.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }

    const cacheKey = `${identity.issuer}\u0000${identity.subject}\u0000${identity.platform}`
    const cached = await this.cache?.get(cacheKey)
    if (this.config.accountCacheTtlMs > 0 && cached) {
      debugLog(this.config.debugAuthLogs, 'account.cache_hit', {
        platform: identity.platform,
        durationMs: Date.now() - startedAt,
      })
      return {
        ...cached,
        ...(identity.name ? { displayName: identity.name } : {}),
        ...(identity.username ? { username: identity.username } : {}),
        ...(identity.email ? { email: identity.email } : {}),
      }
    }

    debugLog(this.config.debugAuthLogs, 'account.provision_started', {
      subjectHash: fingerprintForLog(identity.subject),
      platform: identity.platform,
    })

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
          ...(identity.username ? { username: identity.username } : {}),
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.role === undefined ? {} : { role: identity.role }),
        },
        { idempotencyKey: idempotencyKey(cacheKey) },
      )
      const apiKey = binding.apiKey ?? binding.key ?? binding.token
      if (!apiKey) {
        throw new ServiceError('NewAPI did not return a usable relay key', 502, 'NEW_API_KEY_UNAVAILABLE')
      }
      const tokenQuota = optionalNumber(binding.tokenQuota ?? binding.token_quota)
      const tokenQuotaUsed = optionalNumber(binding.tokenQuotaUsed ?? binding.token_quota_used)
      const tokenUnlimitedQuota = optionalBoolean(binding.tokenUnlimitedQuota ?? binding.token_unlimited_quota)
      const quotaDisplayType = optionalString(binding.quotaDisplayType ?? binding.quota_display_type)
      const quotaPerUnit = optionalNumber(binding.quotaPerUnit ?? binding.quota_per_unit)
      const usdExchangeRate = optionalNumber(binding.usdExchangeRate ?? binding.usd_exchange_rate)
      const customCurrencySymbol = optionalString(binding.customCurrencySymbol ?? binding.custom_currency_symbol)
      const customCurrencyExchangeRate = optionalNumber(
        binding.customCurrencyExchangeRate ?? binding.custom_currency_exchange_rate,
      )
      const account: ResolvedAccount = {
        userId: binding.userId,
        platform: identity.platform,
        apiKey,
        ...(identity.name ? { displayName: identity.name } : {}),
        ...(identity.username ? { username: identity.username } : {}),
        ...(identity.email ? { email: identity.email } : {}),
        ...(binding.tokenId === undefined ? {} : { tokenId: binding.tokenId }),
        ...(binding.quota === undefined ? {} : { quota: binding.quota }),
        ...(binding.quotaUsed === undefined ? {} : { quotaUsed: binding.quotaUsed }),
        ...(tokenQuota === undefined ? {} : { tokenQuota }),
        ...(tokenQuotaUsed === undefined ? {} : { tokenQuotaUsed }),
        ...(tokenUnlimitedQuota === undefined ? {} : { tokenUnlimitedQuota }),
        ...(quotaDisplayType === undefined ? {} : { quotaDisplayType }),
        ...(quotaPerUnit === undefined ? {} : { quotaPerUnit }),
        ...(usdExchangeRate === undefined ? {} : { usdExchangeRate }),
        ...(customCurrencySymbol === undefined ? {} : { customCurrencySymbol }),
        ...(customCurrencyExchangeRate === undefined ? {} : { customCurrencyExchangeRate }),
      }
      await this.cache?.set(cacheKey, account, this.config.accountCacheTtlMs)
      debugLog(this.config.debugAuthLogs, 'account.provision_succeeded', {
        platform: identity.platform,
        userId: binding.userId,
        durationMs: Date.now() - startedAt,
      })
      return account
    } catch (error) {
      if (error instanceof ServiceError) {
        debugLog(this.config.debugAuthLogs, 'account.provision_failed', {
          platform: identity.platform,
          status: error.status,
          code: error.code,
          durationMs: Date.now() - startedAt,
        })
        throw error
      }
      if (error instanceof AiAccountError) {
        debugLog(this.config.debugAuthLogs, 'account.provision_failed', {
          platform: identity.platform,
          status: error.status,
          code: safeUpstreamErrorCode(error.code),
          durationMs: Date.now() - startedAt,
        })
        throw new ServiceError('NewAPI account provisioning failed', 502, safeUpstreamErrorCode(error.code))
      }
      debugLog(this.config.debugAuthLogs, 'account.provision_failed', {
        platform: identity.platform,
        durationMs: Date.now() - startedAt,
        ...safeErrorMetadata(error),
      })
      throw new ServiceError('NewAPI account provisioning failed', 502, 'NEW_API_PROVISION_FAILED')
    }
  }
}

function safeUpstreamErrorCode(value: unknown): string {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value
  return 'NEW_API_PROVISION_FAILED'
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function idempotencyKey(value: string): string {
  return `account-${createHash('sha256').update(value).digest('hex')}`
}
