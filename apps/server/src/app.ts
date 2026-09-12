import { randomUUID } from 'node:crypto'

import { Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

import { resolvePaymentRedirect, type ServiceConfig } from './config.js'
import { debugLog, errorLog, safeErrorMetadata } from './diagnostics.js'
import { ServiceError } from './errors.js'
import {
  NewApiPaymentService,
  normalizeTopUpInfo,
  resolveTopUpRequest,
  sanitizeSubscriptionPayload,
} from './payments.js'
import type {
  AccountResolver,
  PublicAccount,
  PaymentService,
  TokenVerificationOptions,
  TokenVerifier,
  VerifiedIdentity,
} from './types.js'

interface AppEnvironment {
  Variables: {
    identity: VerifiedIdentity
    requestId: string
  }
}

export interface AppDependencies {
  verifier: TokenVerifier
  accounts: AccountResolver
  payments?: PaymentService
  fetch?: typeof fetch
}

export function createApp(config: ServiceConfig, dependencies: AppDependencies) {
  const app = new Hono<AppEnvironment>()
  const upstreamFetch = dependencies.fetch ?? fetch
  const payments = dependencies.payments ?? new NewApiPaymentService(config, upstreamFetch)

  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    const requestPath = new URL(c.req.url).pathname
    const origin = c.req.header('origin')
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    const startedAt = Date.now()
    debugLog(config.debugAuthLogs, 'request.received', {
      requestId,
      method: c.req.method,
      path: requestPath,
      origin: origin ?? null,
      hasAuthorization: Boolean(c.req.header('authorization')),
    })
    try {
      if (origin && !isAllowedOrigin(origin, c.req.url, config.corsAllowedOrigins)) {
        debugLog(config.debugAuthLogs, 'cors.rejected', { requestId, path: requestPath, origin })
        return c.json({ success: false, code: 'CORS_ORIGIN_FORBIDDEN', message: 'Origin is not allowed' }, 403)
      }
      await next()
    } finally {
      debugLog(config.debugAuthLogs, 'request.completed', {
        requestId,
        method: c.req.method,
        path: requestPath,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      })
    }
  })
  app.use(
    '*',
    cors({
      // Same-origin browser requests are already confined to this service and
      // should keep working even when the operator only lists cross-origin
      // customer frontends in CORS_ALLOWED_ORIGINS. Cross-origin
      // requests still require an exact configured origin.
      origin: (origin, c) => (isAllowedOrigin(origin, c.req.url, config.corsAllowedOrigins) ? origin : ''),
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
    if (!token) {
      debugLog(config.debugAuthLogs, 'auth.token_missing', { requestId: c.get('requestId') })
      throw new ServiceError('Bearer access token is required', 401, 'AUTH_TOKEN_REQUIRED')
    }
    const identity = await dependencies.verifier.verify(token, options)
    c.set('identity', identity)
    debugLog(config.debugAuthLogs, 'auth.middleware_passed', {
      requestId: c.get('requestId'),
      clientId: identity.clientId,
      platform: identity.platform,
      scopes: identity.scopes,
    })
    await next()
  }
  app.use('/api/*', authenticate)
  app.use('/v1/*', authenticate)
  app.use('/v1/*', async (c, next) => {
    const maximumBytes = config.maxRequestBodyBytes
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

  app.get('/api/account', async (c) => {
    const requestId = c.get('requestId')
    debugLog(config.debugAuthLogs, 'account.endpoint_started', { requestId })
    const account = await dependencies.accounts.resolve(c.get('identity'))
    const data: PublicAccount = {
      userId: account.userId,
      platform: account.platform,
      ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
      ...(account.username === undefined ? {} : { username: account.username }),
      ...(account.email === undefined ? {} : { email: account.email }),
      ...(account.tokenId === undefined ? {} : { tokenId: account.tokenId }),
      ...(account.quota === undefined ? {} : { quota: account.quota }),
      ...(account.quotaUsed === undefined ? {} : { quotaUsed: account.quotaUsed }),
      ...(account.tokenQuota === undefined ? {} : { tokenQuota: account.tokenQuota }),
      ...(account.tokenQuotaUsed === undefined ? {} : { tokenQuotaUsed: account.tokenQuotaUsed }),
      ...(account.tokenUnlimitedQuota === undefined ? {} : { tokenUnlimitedQuota: account.tokenUnlimitedQuota }),
      ...(account.quotaDisplayType === undefined ? {} : { quotaDisplayType: account.quotaDisplayType }),
      ...(account.quotaPerUnit === undefined ? {} : { quotaPerUnit: account.quotaPerUnit }),
      ...(account.usdExchangeRate === undefined ? {} : { usdExchangeRate: account.usdExchangeRate }),
      ...(account.customCurrencySymbol === undefined ? {} : { customCurrencySymbol: account.customCurrencySymbol }),
      ...(account.customCurrencyExchangeRate === undefined ? {} : { customCurrencyExchangeRate: account.customCurrencyExchangeRate }),
    }
    c.header('Cache-Control', 'no-store')
    debugLog(config.debugAuthLogs, 'account.endpoint_succeeded', {
      requestId,
      platform: account.platform,
    })
    return c.json({ success: true, data })
  })

  app.get('/api/billing/topup/info', async (c) => {
    return paymentResponse(c, { data: normalizeTopUpInfo(await payments.getTopUpInfo()) })
  })

  app.get('/api/billing/topups', async (c) => {
    const account = await paymentsAccount(dependencies.accounts, c)
    const page = parseQueryInteger(c.req.query('page'))
    const pageSize = parseQueryInteger(c.req.query('page_size'))
    const keyword = boundedQuery(c.req.query('keyword'))
    const result = await payments.listTopUps(account.userId, {
      ...(page === undefined ? {} : { page }),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(keyword === undefined ? {} : { keyword }),
    })
    return paymentResponse(c, result)
  })

  app.post('/api/billing/topups', async (c) => {
    const input = await readJsonBody(c)
    const identity = c.get('identity')
    const redirect = resolvePaymentRedirect(
      config.logtoClientPlatforms.get(identity.clientId),
      c.req.header('origin'),
    )
    const account = await paymentsAccount(dependencies.accounts, c)
    const request = resolveTopUpRequest(await payments.getTopUpInfo(), input, redirect)
    return topUpResponse(
      c,
      await payments.createTopUp(account.userId, request.provider, request.payload),
    )
  })

  app.get('/api/billing/subscription/plans', async (c) => {
    return paymentResponse(c, await payments.getSubscriptionPlans())
  })

  app.get('/api/billing/subscription/self', async (c) => {
    const account = await paymentsAccount(dependencies.accounts, c)
    return paymentResponse(c, await payments.getSubscriptionSelf(account.userId))
  })

  app.post('/api/billing/subscription/:provider', async (c) => {
    const input = await readJsonBody(c)
    const request = sanitizeSubscriptionPayload(c.req.param('provider'), input)
    const account = await paymentsAccount(dependencies.accounts, c)
    return paymentResponse(
      c,
      await payments.purchaseSubscription(account.userId, request.provider, request.payload),
    )
  })

  app.get('/api/client-credential', async (c) => {
    // This endpoint deliberately returns a bearer credential. Keep it out of
    // browser-readable flows even when the browser origin is otherwise
    // allowed to call the Account Service. Trusted native clients and
    // server-to-server callers do not send Origin.
    if (c.req.header('origin')) {
      return c.json(
        {
          success: false,
          code: 'CLIENT_CREDENTIAL_ORIGIN_FORBIDDEN',
          message: 'Client credential is not available to browsers',
        },
        403,
      )
    }

    const account = await dependencies.accounts.resolve(c.get('identity'))
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    c.header('Pragma', 'no-cache')
    c.header('Expires', '0')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', "default-src 'none'")
    c.header('Referrer-Policy', 'no-referrer')
    return c.json({
      success: true,
      data: {
        baseUrl: config.newApiBaseUrl,
        apiKey: account.apiKey,
        // A fixed default the shell can use without asking the user; NewAPI may
        // instead whitelist models per role. Empty when unset.
        modelName: config.clientDefaultModel,
        expiresAt: 0,
      },
    })
  })

  app.all('/v1/*', async (c) => {
    const requestId = c.get('requestId')
    const requestUrl = new URL(c.req.url)
    if (!config.newApiBaseUrl || !config.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${config.newApiBaseUrl}/`)
    const body = await requestBody(c.req.raw, config.maxRequestBodyBytes)
    const account = await dependencies.accounts.resolve(c.get('identity'))
    const headers = upstreamRequestHeaders(c.req.raw.headers, account.apiKey)
    const startedAt = Date.now()
    debugLog(config.debugAuthLogs, 'relay.request_started', {
      requestId,
      method: c.req.method,
      path: requestUrl.pathname,
      platform: account.platform,
    })
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
    } catch (error) {
      debugLog(config.debugAuthLogs, 'relay.request_failed', {
        requestId,
        path: requestUrl.pathname,
        durationMs: Date.now() - startedAt,
        ...safeErrorMetadata(error),
      })
      throw new ServiceError('NewAPI is unavailable', 502, 'NEW_API_UNAVAILABLE')
    }
    debugLog(config.debugAuthLogs, 'relay.response_received', {
      requestId,
      path: requestUrl.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    })
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: downstreamResponseHeaders(response.headers),
    })
  })

  app.notFound((c) => c.json({ success: false, code: 'NOT_FOUND', message: 'Not found' }, 404))
  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      errorLog('request.failed', {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: error.status,
        code: error.code,
      })
      return c.json({ success: false, code: error.code, message: error.message }, error.status as 400)
    }
    // Never log arbitrary downstream/upstream error messages: SDK and fetch
    // errors can contain Authorization values or provider payloads. Keep the
    // production log deliberately fixed and secret-free.
    errorLog('request.failed', {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: 500,
      code: 'INTERNAL_ERROR',
    })
    return c.json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal server error' }, 500)
  })

  return app
}

async function paymentsAccount(
  accounts: AccountResolver,
  c: Parameters<MiddlewareHandler<AppEnvironment>>[0],
) {
  return accounts.resolve(c.get('identity'))
}

async function readJsonBody(
  c: Parameters<MiddlewareHandler<AppEnvironment>>[0],
): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ServiceError('Invalid payment request', 400, 'INVALID_PAYMENT_REQUEST')
  }
}

function paymentResponse(
  c: Parameters<MiddlewareHandler<AppEnvironment>>[0],
  payload: Record<string, unknown>,
) {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
  c.header('Expires', '0')
  return c.json({
    success: true,
    data: payload.data ?? null,
    ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
  })
}

function topUpResponse(
  c: Parameters<MiddlewareHandler<AppEnvironment>>[0],
  payload: Record<string, unknown>,
) {
  const rawData = isRecord(payload.data) ? payload.data : {}
  const formUrl = typeof payload.url === 'string' ? payload.url : ''
  const paymentUrl = formUrl || firstString(rawData, ['checkout_url', 'payment_url', 'pay_link', 'url'])
  const fields = formUrl ? primitivePaymentFields(rawData) : undefined
  const orderId = firstString(rawData, ['order_id', 'orderId', 'trade_no', 'out_trade_no'])
  return paymentResponse(c, {
    data: {
      ...(paymentUrl ? { payment_url: paymentUrl } : {}),
      ...(fields && Object.keys(fields).length > 0 ? { payment_fields: fields } : {}),
      ...(orderId ? { order_id: orderId } : {}),
    },
  })
}

function primitiveFields(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(([key, item]) => [key, String(item)]),
  )
}

function primitivePaymentFields(value: Record<string, unknown>) {
  const excluded = new Set(['checkout_url', 'payment_url', 'pay_link', 'url', 'order_id', 'orderId', 'trade_no'])
  return Object.fromEntries(
    Object.entries(primitiveFields(value)).filter(([key]) => !excluded.has(key)),
  )
}

function firstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseQueryInteger(value: string | undefined): number | undefined {
  if (!value || !/^[0-9]+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function boundedQuery(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, 128) : undefined
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
    const browserOrigin = new URL(origin)
    if (browserOrigin.origin !== origin) return false
    const serverUrl = new URL(requestUrl)
    if (serverUrl.origin === browserOrigin.origin) return true

    // TLS is commonly terminated by a reverse proxy, so the Node adapter sees
    // http://example.com while the browser correctly sends
    // Origin: https://example.com. Treat only that secure protocol upgrade on
    // the exact same host (including any explicit port) as same-origin. The
    // reverse direction remains forbidden and unrelated hosts still require
    // an explicit CORS allowlist entry.
    return serverUrl.protocol === 'http:'
      && browserOrigin.protocol === 'https:'
      && serverUrl.host === browserOrigin.host
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
