import { ServiceError } from './errors.js'

export interface ServiceConfig {
  port: number
  debugAuthLogs: boolean
  corsAllowedOrigins: ReadonlySet<string>
  logtoIssuer: string
  logtoAudience: string
  logtoJwksUri: string
  logtoRequiredScopes: readonly string[]
  logtoClientPlatforms: ReadonlyMap<string, LogtoClientConfig>
  /** Scope that grants the NewAPI admin role (mapped to NewAPI role 10). */
  logtoAdminScope: string
  /** Scope that grants the NewAPI root role (mapped to NewAPI role 100). */
  logtoRootScope: string
  newApiBaseUrl: string
  newApiInternalToken: string
  /** Default model name returned to trusted clients; empty means none. */
  clientDefaultModel: string
  /** Optional Redis connection URL. Empty means in-memory caching only. */
  redisUrl: string
  accountCacheTtlMs: number
  maxRequestBodyBytes: number
}

export type LogtoClientType = 'web' | 'desktop'

export interface PaymentRedirect {
  successUrl: string
  cancelUrl?: string
}

export interface LogtoClientConfig {
  platform: string
  clientType: LogtoClientType
  webRedirects: ReadonlyMap<string, PaymentRedirect>
  desktopRedirect?: PaymentRedirect
}

export function resolvePaymentRedirect(client: LogtoClientConfig | undefined, origin: string | undefined): PaymentRedirect {
  if (!client) {
    throw new ServiceError('Payment redirect is not configured for this client', 500, 'PAYMENT_REDIRECT_NOT_CONFIGURED')
  }
  if (client.clientType === 'desktop') {
    if (!client.desktopRedirect) {
      throw new ServiceError('Payment redirect is not configured for this desktop client', 500, 'PAYMENT_REDIRECT_NOT_CONFIGURED')
    }
    return client.desktopRedirect
  }
  if (!origin) {
    throw new ServiceError('Payment redirect origin is required', 400, 'PAYMENT_REDIRECT_ORIGIN_REQUIRED')
  }
  const redirect = client.webRedirects.get(origin)
  if (!redirect) {
    throw new ServiceError('Payment redirect origin is not configured', 400, 'PAYMENT_REDIRECT_ORIGIN_NOT_CONFIGURED')
  }
  return redirect
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const logtoIssuer = requiredUrl(env.LOGTO_ISSUER, 'LOGTO_ISSUER')
  const corsAllowedOrigins = parseOrigins(env.CORS_ALLOWED_ORIGINS ?? '')
  return {
    port: positiveInteger(env.PORT ?? '8787', 'PORT'),
    debugAuthLogs: parseBoolean(env.DEBUG_AUTH_LOGS ?? '0', 'DEBUG_AUTH_LOGS'),
    corsAllowedOrigins,
    logtoIssuer,
    logtoAudience: required(env.LOGTO_AUDIENCE, 'LOGTO_AUDIENCE'),
    logtoJwksUri: requiredUrl(env.LOGTO_JWKS_URI ?? `${logtoIssuer}/jwks`, 'LOGTO_JWKS_URI'),
    logtoRequiredScopes: parseRequiredList(env.LOGTO_REQUIRED_SCOPES ?? 'ai:invoke', 'LOGTO_REQUIRED_SCOPES'),
    logtoClientPlatforms: parseClientPlatforms(
      env.LOGTO_CLIENT_PLATFORM_MAP ?? '{}',
      corsAllowedOrigins,
    ),
    logtoAdminScope: requireScope(env.LOGTO_ADMIN_SCOPE ?? 'account:admin', 'LOGTO_ADMIN_SCOPE'),
    logtoRootScope: requireScope(env.LOGTO_ROOT_SCOPE ?? 'account:root', 'LOGTO_ROOT_SCOPE'),
    newApiBaseUrl: optionalUrl(env.NEW_API_BASE_URL, 'NEW_API_BASE_URL'),
    newApiInternalToken: optionalString(env.NEW_API_INTERNAL_TOKEN) ?? '',
    clientDefaultModel: optionalString(env.CLIENT_DEFAULT_MODEL) ?? '',
    redisUrl: optionalRedisUrl(env.REDIS_URL),
    accountCacheTtlMs: nonNegativeInteger(env.ACCOUNT_CACHE_TTL_SECONDS ?? '300', 'ACCOUNT_CACHE_TTL_SECONDS') * 1000,
    maxRequestBodyBytes: positiveInteger(env.MAX_REQUEST_BODY_BYTES ?? '20971520', 'MAX_REQUEST_BODY_BYTES'),
  }
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  throw new ServiceError(`${name} must be a boolean`, 500, 'CONFIG_INVALID')
}

function requireScope(value: string | undefined, name: string): string {
  const normalized = required(value, name)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-:.]{0,127}$/.test(normalized)) {
    throw new ServiceError(`${name} must be a syntactically valid OAuth scope`, 500, 'CONFIG_INVALID')
  }
  return normalized
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

function optionalRedisUrl(value: string | undefined): string {
  const raw = optionalString(value)
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ServiceError('REDIS_URL must be a valid redis:// or rediss:// URL', 500, 'CONFIG_INVALID')
  }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new ServiceError('REDIS_URL must be a redis:// or rediss:// URL', 500, 'CONFIG_INVALID')
  }
  return url.toString()
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

function parseClientPlatforms(raw: string, corsOrigins: ReadonlySet<string>): ReadonlyMap<string, LogtoClientConfig> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP must be a JSON object', 500, 'CONFIG_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP must be a JSON object', 500, 'CONFIG_INVALID')
  }
  const result = new Map<string, LogtoClientConfig>()
  for (const [clientId, rawConfig] of Object.entries(value)) {
    const normalizedClientId = clientId.trim()
    if (!normalizedClientId) {
      throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid entry', 500, 'CONFIG_INVALID')
    }
    result.set(normalizedClientId, parseClientConfig(rawConfig, corsOrigins))
  }
  return result
}

function parseClientConfig(value: unknown, corsOrigins: ReadonlySet<string>): LogtoClientConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid entry', 500, 'CONFIG_INVALID')
  }
  const record = value as Record<string, unknown>
  const platform = requiredPlatform(record.platform)
  const clientType = record.client_type
  if (clientType !== 'web' && clientType !== 'desktop') {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid client_type', 500, 'CONFIG_INVALID')
  }
  if (!record.redirects || typeof record.redirects !== 'object' || Array.isArray(record.redirects)) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP requires redirects for every client', 500, 'CONFIG_INVALID')
  }

  if (clientType === 'desktop') {
    return {
      platform,
      clientType,
      desktopRedirect: parseRedirect(record.redirects),
      webRedirects: new Map(),
    }
  }

  const webRedirects = new Map<string, PaymentRedirect>()
  for (const [origin, redirect] of Object.entries(record.redirects)) {
    const normalizedOrigin = parseOrigin(origin)
    if (!corsOrigins.has(normalizedOrigin)) {
      throw new ServiceError(`payment redirect origin must be listed in CORS_ALLOWED_ORIGINS: ${origin}`, 500, 'CONFIG_INVALID')
    }
    webRedirects.set(normalizedOrigin, parseRedirect(redirect))
  }
  if (webRedirects.size === 0) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP requires a web redirect', 500, 'CONFIG_INVALID')
  }
  return { platform, clientType, webRedirects }
}

function requiredPlatform(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value) || value.trim().toLowerCase() === 'admin') {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid platform', 500, 'CONFIG_INVALID')
  }
  return value.trim()
}

function parseRedirect(value: unknown): PaymentRedirect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('LOGTO_CLIENT_PLATFORM_MAP contains an invalid redirect', 500, 'CONFIG_INVALID')
  }
  const record = value as Record<string, unknown>
  const successUrl = parsePaymentRedirectURL(record.success_url, 'success_url')
  const cancelUrl = record.cancel_url === undefined
    ? undefined
    : parsePaymentRedirectURL(record.cancel_url, 'cancel_url')
  return cancelUrl === undefined ? { successUrl } : { successUrl, cancelUrl }
}

function parseOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ServiceError(`invalid payment redirect origin: ${value}`, 500, 'CONFIG_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new ServiceError(`payment redirect origin must contain only scheme, host and port: ${value}`, 500, 'CONFIG_INVALID')
  }
  return url.origin
}

function parsePaymentRedirectURL(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ServiceError(`payment redirect ${name} is required`, 500, 'CONFIG_INVALID')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ServiceError(`payment redirect ${name} must be a valid URL`, 500, 'CONFIG_INVALID')
  }
  if (!url.protocol || !url.host || url.username || url.password || url.hash) {
    throw new ServiceError(`payment redirect ${name} is invalid`, 500, 'CONFIG_INVALID')
  }
  if (['blob:', 'data:', 'file:', 'ftp:', 'javascript:', 'mailto:'].includes(url.protocol)) {
    throw new ServiceError(`payment redirect ${name} uses a forbidden scheme`, 500, 'CONFIG_INVALID')
  }
  return url.toString()
}
