import { Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

import { adminAssetResponse } from './admin-assets.js'
import type { ServiceConfig } from './config.js'
import { ServiceError } from './errors.js'
import type { RuntimeConfigStore } from './runtime-config.js'
import type {
  AccountResolver,
  PublicAccount,
  TokenVerificationOptions,
  TokenVerifier,
  VerifiedIdentity,
} from './types.js'

const ADMIN_CONFIG_MAX_BODY_BYTES = 1_048_576

interface AppEnvironment {
  Variables: {
    identity: VerifiedIdentity
  }
}

export interface AppDependencies {
  verifier: TokenVerifier
  accounts: AccountResolver
  runtimeConfig?: RuntimeConfigStore
  adminUiRoot?: string
  fetch?: typeof fetch
}

export function createApp(config: ServiceConfig, dependencies: AppDependencies) {
  const app = new Hono<AppEnvironment>()
  const upstreamFetch = dependencies.fetch ?? fetch
  const getConfig = () => dependencies.runtimeConfig?.getConfig() ?? config

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && !isAllowedOrigin(origin, c.req.url, getConfig().corsAllowedOrigins)) {
      return c.json({ success: false, code: 'CORS_ORIGIN_FORBIDDEN', message: 'Origin is not allowed' }, 403)
    }
    await next()
  })
  app.use(
    '*',
    cors({
      // Same-origin browser requests are already confined to this service and
      // should keep working even when the operator only lists cross-origin
      // customer/admin frontends in CORS_ALLOWED_ORIGINS. Cross-origin
      // requests still require an exact configured origin.
      origin: (origin, c) => (isAllowedOrigin(origin, c.req.url, getConfig().corsAllowedOrigins) ? origin : ''),
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Type', 'X-Request-Id'],
      maxAge: 86_400,
    }),
  )

  const authenticate = async (
    c: Parameters<MiddlewareHandler<AppEnvironment>>[0],
    next: Parameters<MiddlewareHandler<AppEnvironment>>[1],
    options?: TokenVerificationOptions,
  ) => {
    const token = bearerToken(c.req.header('authorization'))
    if (!token) throw new ServiceError('Bearer access token is required', 401, 'AUTH_TOKEN_REQUIRED')
    c.set('identity', await dependencies.verifier.verify(token, options))
    await next()
  }
  app.use('/api/*', async (c, next) => {
    // Administrative endpoints have a stricter, route-specific policy below.
    // Do not run the normal `ai:invoke` policy first, otherwise an admin token
    // would need unrelated AI permission and a normal AI token could be
    // accidentally treated as an administrator.
    if (c.req.path.startsWith('/api/admin/')) return next()
    return authenticate(c, next)
  })
  app.use('/api/admin/*', async (c, next) => {
    if (!bearerToken(c.req.header('authorization'))) {
      throw new ServiceError('Bearer access token is required', 401, 'AUTH_TOKEN_REQUIRED')
    }
    const requiredScopes = c.req.method === 'GET' || c.req.method === 'HEAD'
      ? ['config:read']
      : ['config:write']
    return authenticate(c, next, {
      requiredScopes,
      adminRoute: true,
    })
  })
  app.use('/v1/*', authenticate)
  app.use('/v1/*', async (c, next) => {
    const maximumBytes = getConfig().maxRequestBodyBytes
    const declaredLength = Number(c.req.header('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      return c.json(
        { success: false, code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body is too large' },
        413,
      )
    }
    return next()
  })

  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // The UI is optional at runtime (it can also be deployed independently),
  // but serving the built assets from the same origin makes the secure default
  // convenient and avoids cross-origin token handling for small deployments.
  if (dependencies.adminUiRoot) {
    const adminUiRoot = dependencies.adminUiRoot
    app.get('/admin', (c) => c.redirect('/admin/', 308))
    app.get('/admin/', async () => adminAssetResponse(adminUiRoot, 'index.html'))
    app.get('/admin/main.js', async () => adminAssetResponse(adminUiRoot, 'main.js'))
    app.get('/admin/oidc.js', async () => adminAssetResponse(adminUiRoot, 'oidc.js'))
    app.get('/admin/main.js.map', async () => adminAssetResponse(adminUiRoot, 'main.js.map'))
    app.get('/admin/oidc.js.map', async () => adminAssetResponse(adminUiRoot, 'oidc.js.map'))
    app.get('/admin/styles.css', async () => adminAssetResponse(adminUiRoot, 'styles.css'))
  }

  // Public bootstrap metadata for the standalone admin page. It contains
  // only OIDC values that are safe to expose to a browser; no client secret or
  // NewAPI credential is ever returned.
  app.get('/admin/oidc-config', (c) => {
    const activeConfig = getConfig()
    c.header('Cache-Control', 'no-store')
    return c.json({
      success: true,
      data: {
        issuer: activeConfig.logtoIssuer,
        audience: activeConfig.logtoAudience,
        scopes: ['openid', 'config:read', 'config:write'],
        ...(activeConfig.logtoAdminClientId ? { clientId: activeConfig.logtoAdminClientId } : {}),
        ...(activeConfig.logtoAdminRedirectUri ? { redirectUri: activeConfig.logtoAdminRedirectUri } : {}),
      },
    })
  })

  app.get('/api/account', async (c) => {
    const account = await dependencies.accounts.resolve(c.get('identity'))
    const data: PublicAccount = {
      userId: account.userId,
      platform: account.platform,
      ...(account.tokenId === undefined ? {} : { tokenId: account.tokenId }),
      ...(account.quota === undefined ? {} : { quota: account.quota }),
      ...(account.quotaUsed === undefined ? {} : { quotaUsed: account.quotaUsed }),
    }
    c.header('Cache-Control', 'no-store')
    return c.json({ success: true, data })
  })

  app.get('/api/admin/config', (c) => {
    if (!dependencies.runtimeConfig) {
      throw new ServiceError('Runtime configuration management is not enabled', 503, 'CONFIG_MANAGEMENT_DISABLED')
    }
    c.header('Cache-Control', 'no-store')
    return c.json({ success: true, data: dependencies.runtimeConfig.getPublicConfig() })
  })

  app.post('/api/admin/config/validate', async (c) => {
    if (!dependencies.runtimeConfig) {
      throw new ServiceError('Runtime configuration management is not enabled', 503, 'CONFIG_MANAGEMENT_DISABLED')
    }
    const { patch, expectedVersion } = await readConfigPatch(c)
    const preview = dependencies.runtimeConfig.preview(patch, expectedVersion)
    c.header('Cache-Control', 'no-store')
    return c.json({
      success: true,
      data: {
        valid: true,
        version: preview.version,
        updatedAt: preview.updatedAt,
      },
    })
  })

  app.put('/api/admin/config', async (c) => {
    if (!dependencies.runtimeConfig) {
      throw new ServiceError('Runtime configuration management is not enabled', 503, 'CONFIG_MANAGEMENT_DISABLED')
    }
    const { patch, expectedVersion } = await readConfigPatch(c)
    const updated = await dependencies.runtimeConfig.update(patch, expectedVersion)
    c.header('Cache-Control', 'no-store')
    return c.json({ success: true, data: dependencies.runtimeConfig.getPublicConfig(updated) })
  })

  app.all('/v1/*', async (c) => {
    const requestUrl = new URL(c.req.url)
    const activeConfig = getConfig()
    if (!activeConfig.newApiBaseUrl || !activeConfig.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${activeConfig.newApiBaseUrl}/`)
    const body = await requestBody(c.req.raw, activeConfig.maxRequestBodyBytes)
    const account = await dependencies.accounts.resolve(c.get('identity'))
    const headers = upstreamRequestHeaders(c.req.raw.headers, account.apiKey)
    let response: Response
    try {
      const requestInit: RequestInit = {
        method: c.req.method,
        headers,
        redirect: 'manual',
        signal: c.req.raw.signal,
        ...(body ? { body } : {}),
      }
      response = await upstreamFetch(targetUrl, requestInit)
    } catch {
      throw new ServiceError('NewAPI is unavailable', 502, 'NEW_API_UNAVAILABLE')
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: downstreamResponseHeaders(response.headers),
    })
  })

  app.notFound((c) => c.json({ success: false, code: 'NOT_FOUND', message: 'Not found' }, 404))
  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      return c.json({ success: false, code: error.code, message: error.message }, error.status as 400)
    }
    // Never log arbitrary downstream/upstream error messages: SDK and fetch
    // errors can contain Authorization values or provider payloads. Keep the
    // production log deliberately fixed and secret-free.
    console.error('Unhandled account service error')
    return c.json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal server error' }, 500)
  })

  return app
}

async function readConfigPatch(c: { req: { raw: Request } }): Promise<{
  patch: Record<string, unknown>
  expectedVersion?: number
}> {
  let body: unknown
  try {
    const bytes = await requestBody(c.req.raw, ADMIN_CONFIG_MAX_BODY_BYTES)
    if (!bytes) throw new Error('empty body')
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError('Configuration update must be valid JSON', 400, 'CONFIG_PATCH_INVALID')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ServiceError('Configuration update must be an object', 400, 'CONFIG_PATCH_INVALID')
  }
  const source = body as Record<string, unknown>
  const expectedVersion = parseExpectedVersion(source.version)
  const { version: _version, ...patch } = source
  return {
    patch,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  }
}

function parseExpectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ServiceError('Configuration version must be a positive integer', 400, 'CONFIG_VERSION_INVALID')
  }
  return parsed
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim())
  return match?.[1]
}

function isAllowedOrigin(origin: string, requestUrl: string, allowedOrigins: ReadonlySet<string>): boolean {
  if (allowedOrigins.has(origin)) return true
  if (!origin) return false
  try {
    return new URL(requestUrl).origin === origin
  } catch {
    return false
  }
}

async function requestBody(request: Request, maximumBytes: number): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ServiceError('Request body is too large', 413, 'REQUEST_BODY_TOO_LARGE')
  }
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ServiceError('Request body is too large', 413, 'REQUEST_BODY_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

function upstreamRequestHeaders(source: Headers, apiKey: string): Headers {
  const result = new Headers()
  for (const name of ['accept', 'content-type', 'idempotency-key', 'x-request-id']) {
    const value = source.get(name)
    if (value) result.set(name, value)
  }
  result.set('Authorization', `Bearer ${apiKey}`)
  return result
}

function downstreamResponseHeaders(source: Headers): Headers {
  const blocked = new Set([
    'access-control-allow-credentials',
    'access-control-allow-headers',
    'access-control-allow-methods',
    'access-control-allow-origin',
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  const result = new Headers()
  source.forEach((value, name) => {
    const normalizedName = name.toLowerCase()
    if (normalizedName.startsWith('access-control-') || blocked.has(normalizedName)) return
    result.append(name, value)
  })
  return result
}
