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
 * still applied when `requiredScopes` is omitted; administrative routes pass
 * their own scope set so that normal AI permissions do not implicitly grant
 * configuration access.
 */
export interface TokenVerificationOptions {
  requiredScopes?: readonly string[]
  /** Marks a control-plane request whose identity is authorized by scope. */
  adminRoute?: boolean
}

/** Runtime configuration control-plane contract used by the HTTP layer. */
export interface RuntimeConfigProvider {
  getConfig(): ServiceConfig
  getPublicConfig(): unknown
  update(patch: unknown, expectedVersion?: number): Promise<unknown>
}

export interface AccountResolver {
  resolve(identity: VerifiedIdentity): Promise<ResolvedAccount>
}
