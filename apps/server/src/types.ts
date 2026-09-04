import type { ServiceConfig } from './config.js'

export interface VerifiedIdentity {
  issuer: string
  subject: string
  clientId: string
  platform: string
  scopes: string[]
  email?: string
  name?: string
}

export interface ResolvedAccount {
  userId: number
  platform: string
  apiKey: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
}

export interface PublicAccount {
  userId: number
  platform: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
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
