export type AccessTokenProvider = () => string | Promise<string>

export interface AccountClientOptions {
  baseUrl: string
  getAccessToken: AccessTokenProvider
  fetch?: typeof fetch
}

export interface AccountSummary {
  userId: number
  platform: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
}

export interface AccountResponse {
  success: true
  data: AccountSummary
}

export class AccountClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AccountClientError'
  }
}

export class CqaiAccountClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: AccountClientOptions) {
    const url = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl must be an HTTP(S) URL without credentials, query, or hash')
    }
    this.baseUrl = url.toString().replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  async getAccount(signal?: AbortSignal): Promise<AccountSummary> {
    const response = await this.request('/api/account', signal ? { signal } : {})
    const payload = await parseJson<AccountResponse>(response)
    return payload.data
  }

  async listModels(signal?: AbortSignal): Promise<Response> {
    return this.request('/v1/models', signal ? { signal } : {})
  }

  async createChatCompletion(body: unknown, options: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async createImage(body: unknown, options: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.request('/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.resolvePath(path)
    const accessToken = (await this.options.getAccessToken()).trim()
    if (!accessToken) throw new AccountClientError('Logto access token is unavailable', 401, 'AUTH_TOKEN_REQUIRED')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return this.fetchImpl(url, { ...init, headers, credentials: 'omit' })
  }

  private resolvePath(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('path must be an absolute service path')
    const url = new URL(path, `${this.baseUrl}/`)
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error('path must stay on the configured service origin')
    return url.toString()
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AccountClientError(`Account service returned a non-JSON response (${response.status})`, response.status)
  }
  const payload = await response.json() as T & { success?: boolean; message?: string; code?: string }
  if (!response.ok || payload.success === false) {
    throw new AccountClientError(payload.message || `Account request failed (${response.status})`, response.status, payload.code)
  }
  return payload
}
