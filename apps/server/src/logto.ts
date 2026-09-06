import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'
import type { TokenVerificationOptions, TokenVerifier, VerifiedIdentity } from './types.js'

interface LogtoPayload extends JWTPayload {
  active?: unknown
  client_id?: unknown
  azp?: unknown
  resource?: unknown
  scope?: unknown
  email?: unknown
  name?: unknown
  username?: unknown
}

type LogtoVerifierConfig = Pick<
  ServiceConfig,
  | 'logtoIssuer'
  | 'logtoAudience'
  | 'logtoJwksUri'
  | 'logtoRequiredScopes'
  | 'logtoClientPlatforms'
  | 'logtoAdminScope'
  | 'logtoRootScope'
>

export class LogtoTokenVerifier implements TokenVerifier {
  private readonly jwks

  constructor(
    private readonly config: LogtoVerifierConfig,
    jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.logtoJwksUri)),
  ) {
    this.jwks = jwks
  }

  async verify(token: string, options: TokenVerificationOptions = {}): Promise<VerifiedIdentity> {
    if (!isJwt(token)) {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }

    let payload: LogtoPayload
    try {
      const result = await jwtVerify<LogtoPayload>(token, this.jwks, {
        issuer: this.config.logtoIssuer,
        audience: this.config.logtoAudience,
        clockTolerance: 5,
      })
      payload = result.payload
    } catch {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }

    return verifiedIdentity(payload, this.config, options)
  }
}

function verifiedIdentity(
  payload: LogtoPayload,
  config: LogtoVerifierConfig,
  options: TokenVerificationOptions,
): VerifiedIdentity {
  // `jose` validates `exp` when the claim is present, but JWT verification
  // does not require the claim by default. Access tokens for this service
  // must always carry a finite NumericDate expiry so a token without an
  // expiration can never become an effectively perpetual bearer credential.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new ServiceError('Access token is missing a valid expiration', 401, 'AUTH_CLAIMS_INVALID')
  }
  if (payload.exp <= Math.floor(Date.now() / 1000) - 5) {
    throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
  }

  const subject = stringClaim(payload.sub)
  const issuer = stringClaim(payload.iss)
  const clientIdClaim = stringClaim(payload.client_id)
  const authorizedPartyClaim = stringClaim(payload.azp)
  if (clientIdClaim && authorizedPartyClaim && clientIdClaim !== authorizedPartyClaim) {
    throw new ServiceError('Access token contains conflicting client claims', 401, 'AUTH_CLAIMS_INVALID')
  }
  const clientId = clientIdClaim ?? authorizedPartyClaim
  if (!subject || !issuer || !clientId) {
    throw new ServiceError('Access token is missing required identity claims', 401, 'AUTH_CLAIMS_INVALID')
  }

  const scopes = parseScopes(payload.scope)
  const requiredScopes = options.requiredScopes ?? config.logtoRequiredScopes
  const missingScope = requiredScopes.find((scope) => !scopes.includes(scope))
  if (missingScope) throw new ServiceError('Required permission is missing', 403, 'AUTH_SCOPE_FORBIDDEN')

  const email = stringClaim(payload.email)
  const name = stringClaim(payload.name) ?? stringClaim(payload.username)
  const platform = config.logtoClientPlatforms.get(clientId)
  if (!platform) throw new ServiceError('Application is not allowed', 403, 'AUTH_CLIENT_FORBIDDEN')

  const role = resolveRole(scopes, config)
  return {
    issuer,
    subject,
    clientId,
    platform,
    scopes,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(role === undefined ? {} : { role }),
  }
}

/**
 * Resolve a trusted NewAPI role from Logto scopes. The root scope takes
 * precedence over the admin scope. A token without either scope stays a
 * regular NewAPI user (no role claim).
 */
function resolveRole(scopes: readonly string[], config: LogtoVerifierConfig): number | undefined {
  if (scopes.includes(config.logtoRootScope)) return 100
  if (scopes.includes(config.logtoAdminScope)) return 10
  return undefined
}

function isJwt(token: string): boolean {
  const parts = token.split('.')
  return parts.length === 3 && parts.every(Boolean)
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value === expected
  return Array.isArray(value) && value.some((item) => item === expected)
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseScopes(value: unknown): string[] {
  if (typeof value === 'string') return [...new Set(value.split(/\s+/).filter(Boolean))]
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)))]
  }
  return []
}
