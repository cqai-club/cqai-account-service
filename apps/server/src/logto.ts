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
  | 'logtoAdminClientId'
>

type IntrospectionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class LogtoTokenVerifier implements TokenVerifier {
  private readonly jwks

  constructor(
    private readonly config: LogtoVerifierConfig,
    jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.logtoJwksUri)),
    private readonly getRuntimeConfig?: () => LogtoVerifierConfig,
    private readonly introspectionFetch: IntrospectionFetch = fetch,
  ) {
    this.jwks = jwks
  }

  async verify(token: string, options: TokenVerificationOptions = {}): Promise<VerifiedIdentity> {
    const config = this.getRuntimeConfig?.() ?? this.config
    if (!isJwt(token)) {
      if (!options.adminRoute) {
        throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
      }
      return this.verifyOpaqueAdminToken(token, config, options)
    }

    let payload: LogtoPayload
    try {
      const result = await jwtVerify<LogtoPayload>(token, this.jwks, {
        issuer: config.logtoIssuer,
        audience: config.logtoAudience,
        clockTolerance: 5,
      })
      payload = result.payload
    } catch {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }

    return verifiedIdentity(payload, config, options)
  }

  private async verifyOpaqueAdminToken(
    token: string,
    config: LogtoVerifierConfig,
    options: TokenVerificationOptions,
  ): Promise<VerifiedIdentity> {
    const adminClientId = config.logtoAdminClientId?.trim()
    if (!adminClientId) {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }

    let payload: LogtoPayload
    try {
      const body = new URLSearchParams({
        token,
        token_type_hint: 'access_token',
        client_id: adminClientId,
      })
      const response = await this.introspectionFetch(`${config.logtoIssuer}/token/introspection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error('introspection request failed')
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid introspection response')
      }
      payload = value as LogtoPayload
    } catch {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }

    if (payload.active !== true) {
      throw new ServiceError('Access token is invalid or expired', 401, 'AUTH_TOKEN_INVALID')
    }
    // An opaque token has no locally verifiable issuer claim. A successful
    // active response from the introspection endpoint derived from the
    // configured issuer is the issuer proof. Logto may omit `iss` from the
    // RFC 7662 response; if it does include one, it must still match exactly.
    const introspectedIssuer = stringClaim(payload.iss)
    // RFC 7662 providers may expose an RFC 8707 resource indicator as
    // `resource` rather than duplicating it into `aud`. Either representation
    // must contain this service's configured resource; neither may be omitted.
    if ((introspectedIssuer && introspectedIssuer !== config.logtoIssuer)
      || (!audienceMatches(payload.aud, config.logtoAudience)
        && !audienceMatches(payload.resource, config.logtoAudience))) {
      throw new ServiceError('Access token has invalid issuer or audience', 401, 'AUTH_CLAIMS_INVALID')
    }

    payload.iss = config.logtoIssuer

    const identity = verifiedIdentity(payload, config, options)
    if (identity.clientId !== adminClientId) {
      throw new ServiceError('Access token was issued to a different application', 401, 'AUTH_CLAIMS_INVALID')
    }
    return identity
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
  if (options.adminRoute) {
    return {
      issuer,
      subject,
      clientId,
      platform: 'admin',
      scopes,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    }
  }

  const platform = config.logtoClientPlatforms.get(clientId)
  if (!platform) throw new ServiceError('Application is not allowed', 403, 'AUTH_CLIENT_FORBIDDEN')

  return {
    issuer,
    subject,
    clientId,
    platform,
    scopes,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  }
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
