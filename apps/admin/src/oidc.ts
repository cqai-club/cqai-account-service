/** The endpoint fields cached by the admin page are issuer-specific. */
export interface CachedOidcEndpoints {
  issuer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
}

export interface OidcDiscoveryEndpoints {
  authorization_endpoint?: unknown
  token_endpoint?: unknown
}

export interface OidcEndpointSelection {
  authorizationEndpoint?: string
  tokenEndpoint?: string
}

export interface AuthorizationCodeTokenRequest {
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  audience?: string
}

/** Build the PKCE code exchange, preserving the RFC 8707 resource binding. */
export function authorizationCodeTokenRequest(input: AuthorizationCodeTokenRequest): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  })
  if (input.audience) body.set('resource', input.audience)
  return body
}

/**
 * Normalize an OIDC endpoint received from discovery or session storage.
 * Endpoint URLs must be absolute HTTP(S) URLs without embedded credentials or
 * fragments. Query parameters are valid and intentionally preserved because
 * some identity providers use them for tenant/routing hints.
 */
export function normalizeOidcEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Compare issuer URLs after normalizing a trailing slash. Invalid cached
 * values are treated as a mismatch, so they can never authorize reuse of an
 * endpoint belonging to another issuer.
 */
export function oidcIssuerMatches(selectedIssuer: unknown, cachedIssuer: unknown): boolean {
  const selected = canonicalIssuer(selectedIssuer)
  const cached = canonicalIssuer(cachedIssuer)
  return selected !== undefined && cached !== undefined && selected === cached
}

/** A pending authorization code may only be redeemed for the same issuer. */
export function pendingLoginIssuerMatches(
  currentIssuer: unknown,
  pendingIssuer: unknown,
): boolean {
  return Boolean(currentIssuer && pendingIssuer && oidcIssuerMatches(currentIssuer, pendingIssuer))
}

/** A pending authorization code may only be redeemed for the same service origin. */
export function pendingLoginServiceOriginMatches(
  currentOrigin: unknown,
  pendingOrigin: unknown,
): boolean {
  const current = canonicalOrigin(currentOrigin)
  const pending = canonicalOrigin(pendingOrigin)
  return current !== undefined && pending !== undefined && current === pending
}

/**
 * OIDC metadata is service-specific even when no bearer token is present. A
 * service selection change therefore invalidates it unconditionally when no
 * token is bound, and on an origin change when one is bound.
 */
export function shouldResetOidcForServiceChange(hasToken: boolean, changedOrigin: boolean): boolean {
  return !hasToken || changedOrigin
}

/**
 * Update the cached issuer while dropping endpoint fields that came from a
 * different issuer. This also clears endpoints whose cache has no issuer
 * metadata, which is safer than guessing their provenance.
 */
export function clearOidcEndpointsOnIssuerChange(
  cached: CachedOidcEndpoints,
  nextIssuer: string,
): CachedOidcEndpoints {
  const next: CachedOidcEndpoints = { ...cached, issuer: nextIssuer }
  if (!oidcIssuerMatches(nextIssuer, cached.issuer)) {
    delete next.authorizationEndpoint
    delete next.tokenEndpoint
  }
  return next
}

/**
 * Prefer the fresh discovery document. Cached endpoints are only a fallback
 * when their issuer exactly matches the issuer currently selected by the
 * operator; changing issuer therefore cannot reuse stale endpoints.
 */
export function selectOidcEndpoints(
  selectedIssuer: string,
  discovery: OidcDiscoveryEndpoints,
  cached: CachedOidcEndpoints,
): OidcEndpointSelection {
  const sameIssuer = oidcIssuerMatches(selectedIssuer, cached.issuer)
  const discoveredAuthorizationEndpoint = normalizeOidcEndpoint(discovery.authorization_endpoint)
  const discoveredTokenEndpoint = normalizeOidcEndpoint(discovery.token_endpoint)
  const cachedAuthorizationEndpoint = sameIssuer ? normalizeOidcEndpoint(cached.authorizationEndpoint) : undefined
  const cachedTokenEndpoint = sameIssuer ? normalizeOidcEndpoint(cached.tokenEndpoint) : undefined
  return {
    ...(discoveredAuthorizationEndpoint
      ? { authorizationEndpoint: discoveredAuthorizationEndpoint }
      : cachedAuthorizationEndpoint
        ? { authorizationEndpoint: cachedAuthorizationEndpoint }
        : {}),
    ...(discoveredTokenEndpoint
      ? { tokenEndpoint: discoveredTokenEndpoint }
      : cachedTokenEndpoint
        ? { tokenEndpoint: cachedTokenEndpoint }
        : {}),
  }
}

function canonicalIssuer(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function canonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}
