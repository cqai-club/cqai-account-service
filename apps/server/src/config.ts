import { ServiceError } from './errors.js'

export interface ServiceConfig {
  port: number
  corsAllowedOrigins: ReadonlySet<string>
  logtoIssuer: string
  logtoAudience: string
  logtoJwksUri: string
  logtoRequiredScopes: readonly string[]
  logtoClientPlatforms: ReadonlyMap<string, string>
  /** Public SPA client metadata used by the standalone admin UI. */
  logtoAdminClientId?: string
  logtoAdminRedirectUri?: string
  newApiBaseUrl: string
  newApiInternalToken: string
  accountCacheTtlMs: number
  maxRequestBodyBytes: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const logtoIssuer = requiredUrl(env.LOGTO_ISSUER, 'LOGTO_ISSUER')
  const adminClientId = optionalString(env.LOGTO_ADMIN_CLIENT_ID)
  const adminRedirectUri = optionalRedirectUri(env.LOGTO_ADMIN_REDIRECT_URI)
  return {
    port: positiveInteger(env.PORT ?? '8787', 'PORT'),
    // These values may be initialized from the admin console after startup.
    // Empty bootstrap values fail closed: same-origin requests still work,
    // while cross-origin calls and unmapped customer clients are rejected.
    corsAllowedOrigins: parseOrigins(env.CORS_ALLOWED_ORIGINS ?? ''),
    logtoIssuer,
    logtoAudience: required(env.LOGTO_AUDIENCE, 'LOGTO_AUDIENCE'),
    logtoJwksUri: requiredUrl(env.LOGTO_JWKS_URI ?? `${logtoIssuer}/jwks`, 'LOGTO_JWKS_URI'),
    logtoRequiredScopes: parseRequiredList(env.LOGTO_REQUIRED_SCOPES ?? 'ai:invoke', 'LOGTO_REQUIRED_SCOPES'),
    logtoClientPlatforms: parseClientPlatforms(env.LOGTO_CLIENT_PLATFORM_MAP ?? '{}'),
    ...(adminClientId ? { logtoAdminClientId: adminClientId } : {}),
    ...(adminRedirectUri ? { logtoAdminRedirectUri: adminRedirectUri } : {}),
    // The service token is server-only. Allow an empty bootstrap value so the
    // admin UI can start, while business requests fail closed until a token is
    // supplied through the environment or a Secret Manager.
    newApiBaseUrl: optionalUrl(env.NEW_API_BASE_URL, 'NEW_API_BASE_URL'),
    newApiInternalToken: optionalString(env.NEW_API_INTERNAL_TOKEN) ?? '',
    accountCacheTtlMs: nonNegativeInteger(env.ACCOUNT_CACHE_TTL_SECONDS ?? '300', 'ACCOUNT_CACHE_TTL_SECONDS') * 1000,
    maxRequestBodyBytes: positiveInteger(env.MAX_REQUEST_BODY_BYTES ?? '20971520', 'MAX_REQUEST_BODY_BYTES'),
  }
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function optionalRedirectUri(value: string | undefined): string | undefined {
  const raw = optionalString(value)
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ServiceError('LOGTO_ADMIN_REDIRECT_URI must be an absolute URL', 500, 'CONFIG_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ServiceError(
      'LOGTO_ADMIN_REDIRECT_URI must be an HTTP(S) URL without credentials or hash',
      500,
      'CONFIG_INVALID',
    )
  }
  return url.toString()
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new ServiceError(`${name} is required`, 500, 'CONFIG_INVALID')
  return normalized
}

function requiredUrl(value: string | undefined, name: string): string {
  const raw = required(value, name)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ServiceError(`${name} must be an absolute URL`, 500, 'CONFIG_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ServiceError(`${name} must be an HTTP(S) URL without credentials, query, or hash`, 500, 'CONFIG_INVALID')
  }
  return url.toString().replace(/\/$/, '')
}

function optionalUrl(value: string | undefined, name: string): string {
  const raw = optionalString(value)
  if (!raw) return ''
  return requiredUrl(raw, name)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ServiceError(`${name} must be a positive integer`, 500, 'CONFIG_INVALID')
  }
  return parsed
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServiceError(`${name} must be a non-negative integer`, 500, 'CONFIG_INVALID')
  }
  return parsed
}

function parseList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
}

function parseRequiredList(raw: string, name: string): string[] {
  const values = parseList(raw)
  if (values.length === 0) throw new ServiceError(`${name} is empty`, 500, 'CONFIG_INVALID')
  return values
}

function parseOrigins(raw: string): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const item of parseList(raw)) {
    if (item === '*') throw new ServiceError('CORS_ALLOWED_ORIGINS must not contain *', 500, 'CONFIG_INVALID')
    let url: URL
    try {
      url = new URL(item)
    } catch {
      throw new ServiceError(`invalid CORS origin: ${item}`, 500, 'CONFIG_INVALID')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== item.replace(/\/$/, '')) {
      throw new ServiceError(`CORS origin must contain only scheme and host: ${item}`, 500, 'CONFIG_INVALID')
    }
    origins.add(url.origin)
  }
  return origins
}

function parseClientPlatforms(raw: string): ReadonlyMap<string, string> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP must be a JSON object', 500, 'CONFIG_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP must be a JSON object', 500, 'CONFIG_INVALID')
  }
  const result = new Map<string, string>()
  for (const [clientId, platform] of Object.entries(value)) {
    if (
      !clientId.trim()
      || typeof platform !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(platform)
      || platform.trim().toLowerCase() === 'admin'
    ) {
      throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid entry', 500, 'CONFIG_INVALID')
    }
    result.set(clientId.trim(), platform)
  }
  return result
}
