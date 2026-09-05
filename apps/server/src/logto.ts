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
  roles?: unknown
  role?: unknown
}

type LogtoVerifierConfig = Pick<
  ServiceConfig,
  | 'logtoIssuer'
  | 'logtoAudience'
  | 'logtoJwksUri'
  | 'logtoRequiredScopes'
  | 'logtoClientPlatforms'
  | 'logtoRoleClaim'
  | 'logtoRoleMap'
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

  const role = resolveRole(payload, config)
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
 * Resolve a trusted NewAPI role from Logto role claims. mapping is read from
 * LOGTO_ROLE_MAP; roles without a mapping never elevate privileges. When
 * multiple roles are claimed, the highest mapped NewAPI role wins and the
 * root role takes precedence over admin.
 */
function resolveRole(payload: LogtoPayload, config: LogtoVerifierConfig): number | undefined {
  const roles = extractRoleNames(payload[config.logtoRoleClaim])
  if (roles.length === 0) return undefined
  let resolved: number | undefined
  for (const role of roles) {
    const mapped = config.logtoRoleMap.get(role)
    if (mapped === undefined) continue
    resolved = resolved === undefined ? mapped : Math.max(resolved, mapped)
  }
  return resolved
}

function extractRoleNames(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [...new Set(raw.split(/[,\s]+/).filter(Boolean))]
  }
  return []
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
