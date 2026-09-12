export type AccessTokenProvider = () => string | Promise<string>

export interface AccountClientOptions {
  baseUrl: string
  getAccessToken: AccessTokenProvider
  fetch?: typeof fetch
}

export interface AccountSummary {
  userId: number
  platform: string
  displayName?: string
  username?: string
  email?: string
  tokenId?: number | string
  quota?: number
  quotaUsed?: number
  tokenQuota?: number
  tokenQuotaUsed?: number
  tokenUnlimitedQuota?: boolean
  quotaDisplayType?: string
  quotaPerUnit?: number
  usdExchangeRate?: number
  customCurrencySymbol?: string
  customCurrencyExchangeRate?: number
}

export interface AccountResponse {
  success: true
  data: AccountSummary
}

export type SubscriptionPaymentProvider = 'balance' | 'epay' | 'stripe' | 'creem' | 'waffo-pancake'

export interface BillingResponse<T = unknown> {
  success: true
  data: T
  url?: string
}

export interface TopUpOption {
  id: string
  name: string
  kind: 'amount' | 'product'
  min_top_up?: number
  choices?: Array<{ id: string; name: string }>
  products?: Array<{ id: string; name: string; price: number; currency: string; quota: number }>
}

export interface TopUpInfo {
  payment_options: TopUpOption[]
  amount_options: number[]
  min_top_up?: number
}

export interface CreateTopUpRequest {
  payment_option_id: string
  amount?: number
  product_id?: string
  choice_id?: string
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

  async getTopUpInfo(signal?: AbortSignal): Promise<TopUpInfo> {
    const response = await this.request('/api/billing/topup/info', signal ? { signal } : {})
    return (await parseJson<BillingResponse<TopUpInfo>>(response)).data
  }

  async listTopUps(
    options: { page?: number; pageSize?: number; keyword?: string } = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = new URLSearchParams()
    if (options.page !== undefined) query.set('page', String(options.page))
    if (options.pageSize !== undefined) query.set('page_size', String(options.pageSize))
    if (options.keyword) query.set('keyword', options.keyword)
    const path = `/api/billing/topups${query.toString() ? `?${query.toString()}` : ''}`
    const response = await this.request(path, signal ? { signal } : {})
    return (await parseJson<BillingResponse>(response)).data
  }

  async createTopUp(
    body: CreateTopUpRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<BillingResponse> {
    const response = await this.request('/api/billing/topups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return parseJson<BillingResponse>(response)
  }

  async getSubscriptionPlans(signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('/api/billing/subscription/plans', signal ? { signal } : {})
    return (await parseJson<BillingResponse>(response)).data
  }

  async getSubscriptionSelf(signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('/api/billing/subscription/self', signal ? { signal } : {})
    return (await parseJson<BillingResponse>(response)).data
  }

  async purchaseSubscription(
    provider: SubscriptionPaymentProvider,
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<BillingResponse> {
    const response = await this.request(`/api/billing/subscription/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return parseJson<BillingResponse>(response)
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
