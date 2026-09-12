import type { LogtoClientType, ServiceConfig } from './config.js'

export interface VerifiedIdentity {
  issuer: string
  subject: string
  clientId: string
  platform: string
  clientType: LogtoClientType
  scopes: string[]
  email?: string
  username?: string
  name?: string
  /**
   * NewAPI numeric role resolved from trusted Logto role claims:
   * 1 common, 10 admin, 100 root. Absent means a normal user.
   */
  role?: number
}

export interface ResolvedAccount {
  userId: number
  platform: string
  apiKey: string
  displayName?: string
  username?: string
  email?: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
  tokenQuota?: number
  tokenQuotaUsed?: number
  tokenUnlimitedQuota?: boolean
  quotaDisplayType?: string
  quotaPerUnit?: number
  usdExchangeRate?: number
  customCurrencySymbol?: string
  customCurrencyExchangeRate?: number
}

export interface PublicAccount {
  userId: number
  platform: string
  displayName?: string
  username?: string
  email?: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
  tokenQuota?: number
  tokenQuotaUsed?: number
  tokenUnlimitedQuota?: boolean
  quotaDisplayType?: string
  quotaPerUnit?: number
  usdExchangeRate?: number
  customCurrencySymbol?: string
  customCurrencyExchangeRate?: number
}

export interface TokenVerifier {
  verify(token: string, options?: TokenVerificationOptions): Promise<VerifiedIdentity>
}

/**
 * Optional per-route authorization constraints. The default verifier policy is
 * still applied when `requiredScopes` is omitted.
 */
export interface TokenVerificationOptions {
  requiredScopes?: readonly string[]
}

export interface AccountResolver {
  resolve(identity: VerifiedIdentity): Promise<ResolvedAccount>
}

export type TopUpProvider = 'epay' | 'stripe' | 'creem' | 'waffo' | 'waffo-pancake'

export type SubscriptionPaymentProvider = 'balance' | 'epay' | 'stripe' | 'creem' | 'waffo-pancake'

export interface PaymentService {
  getTopUpInfo(): Promise<Record<string, unknown>>
  listTopUps(userId: number, options: { page?: number; pageSize?: number; keyword?: string }): Promise<Record<string, unknown>>
  createTopUp(userId: number, provider: TopUpProvider, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  getSubscriptionPlans(): Promise<Record<string, unknown>>
  getSubscriptionSelf(userId: number): Promise<Record<string, unknown>>
  purchaseSubscription(
    userId: number,
    provider: SubscriptionPaymentProvider,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}
