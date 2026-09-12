import { AiAccountError, NewApiHttpClient, type NewApiRequestOptions } from '@cqaiclub/cqai-account-sdk'

import type { PaymentRedirect, ServiceConfig } from './config.js'
import { debugLog, safeErrorMetadata } from './diagnostics.js'
import { ServiceError } from './errors.js'
import type {
  PaymentService,
  SubscriptionPaymentProvider,
  TopUpProvider,
} from './types.js'

type PaymentConfig = Pick<ServiceConfig, 'newApiBaseUrl' | 'newApiInternalToken' | 'debugAuthLogs'>

const topUpProviders = new Set<TopUpProvider>(['epay', 'stripe', 'creem', 'waffo', 'waffo-pancake'])
const subscriptionProviders = new Set<SubscriptionPaymentProvider>([
  'balance',
  'epay',
  'stripe',
  'creem',
  'waffo-pancake',
])

const nonEpayTopUpTypes = new Set(['stripe', 'creem', 'waffo', 'waffo_pancake', 'waffo-pancake'])

const MAX_PAYMENT_AMOUNT = 10_000_000

export type PublicTopUpOption = {
  id: string
  name: string
  kind: 'amount' | 'product'
  min_top_up?: number
  choices?: Array<{ id: string; name: string }>
  products?: Array<{ id: string; name: string; price: number; currency: string; quota: number }>
}

export type PublicTopUpInfo = {
  payment_options: PublicTopUpOption[]
  amount_options: number[]
  min_top_up?: number
}

export class NewApiPaymentService implements PaymentService {
  constructor(
    private readonly config: PaymentConfig,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  async getTopUpInfo(): Promise<Record<string, unknown>> {
    return this.request('/api/internal/payment/topup/info')
  }

  async listTopUps(
    userId: number,
    options: { page?: number; pageSize?: number; keyword?: string },
  ): Promise<Record<string, unknown>> {
    assertUserId(userId)
    return this.request('/api/internal/payment/topup/self', {
      query: {
        user_id: userId,
        p: positivePage(options.page),
        page_size: positivePageSize(options.pageSize),
        ...(options.keyword ? { keyword: options.keyword } : {}),
      },
    })
  }

  async createTopUp(
    userId: number,
    provider: TopUpProvider,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertUserId(userId)
    if (!topUpProviders.has(provider)) {
      throw new ServiceError('Payment provider is not supported', 404, 'PAYMENT_PROVIDER_NOT_FOUND')
    }
    return this.request(`/api/internal/payment/topup/${provider}`, {
      method: 'POST',
      body: { user_id: userId, payload },
    })
  }

  async getSubscriptionPlans(): Promise<Record<string, unknown>> {
    return this.request('/api/internal/payment/subscription/plans')
  }

  async getSubscriptionSelf(userId: number): Promise<Record<string, unknown>> {
    assertUserId(userId)
    return this.request('/api/internal/payment/subscription/self', {
      query: { user_id: userId },
    })
  }

  async purchaseSubscription(
    userId: number,
    provider: SubscriptionPaymentProvider,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertUserId(userId)
    if (!subscriptionProviders.has(provider)) {
      throw new ServiceError('Payment provider is not supported', 404, 'PAYMENT_PROVIDER_NOT_FOUND')
    }
    return this.request(`/api/internal/payment/subscription/${provider}`, {
      method: 'POST',
      body: { user_id: userId, payload },
    })
  }

  private async request<T extends Record<string, unknown> = Record<string, unknown>>(
    path: string,
    options: Omit<NewApiRequestOptions, 'bearerToken' | 'apiKey'> = {},
  ): Promise<T> {
    if (!this.config.newApiBaseUrl || !this.config.newApiInternalToken) {
      throw new ServiceError('NewAPI is not configured', 503, 'NEW_API_NOT_CONFIGURED')
    }

    const startedAt = Date.now()
    try {
      const client = new NewApiHttpClient({
        baseUrl: this.config.newApiBaseUrl,
        serviceToken: this.config.newApiInternalToken,
        fetch: this.requestFetch,
      })
      const response = await client.request<T>(path, {
        ...options,
        bearerToken: this.config.newApiInternalToken,
      })
      if (response.success === false || response.message === 'error') {
        throw new AiAccountError('NewAPI payment request failed', 502, 'PAYMENT_REQUEST_FAILED')
      }
      debugLog(this.config.debugAuthLogs, 'payment.upstream_succeeded', {
        path,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      if (error instanceof ServiceError) throw error
      if (error instanceof AiAccountError) {
        debugLog(this.config.debugAuthLogs, 'payment.upstream_failed', {
          path,
          status: error.status,
          code: safePaymentErrorCode(error.code),
          durationMs: Date.now() - startedAt,
        })
        throw new ServiceError('NewAPI payment request failed', 502, safePaymentErrorCode(error.code))
      }
      debugLog(this.config.debugAuthLogs, 'payment.upstream_failed', {
        path,
        durationMs: Date.now() - startedAt,
        ...safeErrorMetadata(error),
      })
      throw new ServiceError('NewAPI payment request failed', 502, 'PAYMENT_REQUEST_FAILED')
    }
  }
}

export function sanitizeTopUpPayload(
  provider: string,
  input: unknown,
  redirect: PaymentRedirect,
): { provider: TopUpProvider; payload: Record<string, unknown> } {
  if (!isRecord(input)) throw invalidPaymentRequest()
  const normalizedProvider = asTopUpProvider(provider)

  switch (normalizedProvider) {
    case 'epay':
      return {
        provider: normalizedProvider,
        payload: {
          amount: requiredAmount(input.amount),
          payment_method: requiredPaymentMethod(input.payment_method),
          return_url: redirect.successUrl,
        },
      }
    case 'stripe':
      return {
        provider: normalizedProvider,
        payload: {
          amount: requiredAmount(input.amount),
          payment_method: requiredFixedPaymentMethod(input.payment_method, 'stripe'),
          success_url: redirect.successUrl,
          ...(redirect.cancelUrl ? { cancel_url: redirect.cancelUrl } : {}),
        },
      }
    case 'creem':
      return {
        provider: normalizedProvider,
        payload: {
          product_id: requiredText(input.product_id, 'product_id'),
          payment_method: requiredFixedPaymentMethod(input.payment_method, 'creem'),
          success_url: redirect.successUrl,
        },
      }
    case 'waffo': {
      const payload: Record<string, unknown> = { amount: requiredAmount(input.amount) }
      if (input.pay_method_index !== undefined) {
        payload.pay_method_index = requiredNonNegativeInteger(input.pay_method_index, 'pay_method_index')
      }
      payload.return_url = redirect.successUrl
      return { provider: normalizedProvider, payload }
    }
    case 'waffo-pancake':
      return {
        provider: normalizedProvider,
        payload: {
          amount: requiredAmount(input.amount),
          return_url: redirect.successUrl,
        },
      }
  }
}

export function normalizeTopUpInfo(value: unknown): PublicTopUpInfo {
  const data = unwrapPaymentData(value)
  if (!data) return { payment_options: [], amount_options: [] }

  const configuredOptions = readPublicOptions(data.payment_options ?? data.paymentOptions)
  if (configuredOptions.length > 0) {
    const minTopUp = readNumber(data.min_topup ?? data.minTopUp)
    return {
      payment_options: configuredOptions,
      amount_options: readNumbers(data.amount_options ?? data.amountOptions),
      ...(minTopUp === undefined ? {} : { min_top_up: minTopUp }),
    }
  }

  const options: PublicTopUpOption[] = []
  if (readBoolean(data.enable_online_topup ?? data.enableOnlineTopup)) {
    for (const method of readRecords(data.pay_methods ?? data.payMethods)) {
      const type = readString(method.type)
      if (!type || nonEpayTopUpTypes.has(type.toLowerCase())) continue
      const minTopUp = readNumber(method.min_topup ?? method.minTopUp)
      options.push({
        id: `online-${type}`,
        name: readString(method.name) || type,
        kind: 'amount',
        ...(minTopUp === undefined ? {} : { min_top_up: minTopUp }),
      })
    }
  }

  if (readBoolean(data.enable_stripe_topup ?? data.enableStripeTopup)) {
    const minTopUp = readNumber(data.stripe_min_topup ?? data.stripeMinTopUp)
    options.push({
      id: 'card',
      name: 'Stripe',
      kind: 'amount',
      ...(minTopUp === undefined ? {} : { min_top_up: minTopUp }),
    })
  }

  const products = readProducts(data.creem_products ?? data.creemProducts)
  if (readBoolean(data.enable_creem_topup ?? data.enableCreemTopup) && products.length > 0) {
    options.push({ id: 'package', name: 'Creem', kind: 'product', products })
  }

  if (readBoolean(data.enable_waffo_topup ?? data.enableWaffoTopup)) {
    const choices = readRecords(data.waffo_pay_methods ?? data.waffoPayMethods).flatMap((item, index) => {
      const name = readString(item.name)
      return name ? [{ id: String(index), name }] : []
    })
    options.push({ id: 'global', name: 'Waffo', kind: 'amount', ...(choices.length > 0 ? { choices } : {}) })
  }

  if (readBoolean(data.enable_waffo_pancake_topup ?? data.enableWaffoPancakeTopup)) {
    options.push({ id: 'global-pancake', name: 'Pancake', kind: 'amount' })
  }

  const minTopUp = readNumber(data.min_topup ?? data.minTopUp)
  return {
    payment_options: options,
    amount_options: readNumbers(data.amount_options ?? data.amountOptions),
    ...(minTopUp === undefined ? {} : { min_top_up: minTopUp }),
  }
}

export function resolveTopUpRequest(
  infoValue: unknown,
  input: unknown,
  redirect: PaymentRedirect,
): { provider: TopUpProvider; payload: Record<string, unknown> } {
  if (!isRecord(input)) throw invalidPaymentRequest()
  rejectClientRedirectOverrides(input)
  const info = normalizeTopUpInfo(infoValue)
  const optionId = requiredText(input.payment_option_id, 'payment_option_id')
  const option = info.payment_options.find((item) => item.id === optionId)
  if (!option) throw new ServiceError('Payment option is not available', 400, 'PAYMENT_OPTION_NOT_FOUND')

  if (optionId.startsWith('online-')) {
    const paymentMethod = optionId.slice('online-'.length)
    return sanitizeTopUpPayload('epay', { ...input, payment_method: paymentMethod }, redirect)
  }
  if (optionId === 'card') {
    return sanitizeTopUpPayload('stripe', { ...input, payment_method: 'stripe' }, redirect)
  }
  if (optionId === 'package') {
    const productId = requiredText(input.product_id, 'product_id')
    if (!option.products?.some((product) => product.id === productId)) throw new ServiceError('Payment product is not available', 400, 'PAYMENT_PRODUCT_NOT_FOUND')
    return sanitizeTopUpPayload('creem', { ...input, product_id: productId, payment_method: 'creem' }, redirect)
  }
  if (optionId === 'global') {
    const payload: Record<string, unknown> = { ...input }
    delete payload.payment_option_id
    const choiceId = optionalText(input.choice_id)
    if (choiceId) {
      const choice = option.choices?.find((item) => item.id === choiceId)
      const choiceIndex = choice ? Number(choice.id) : -1
      if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0) throw new ServiceError('Payment choice is not available', 400, 'PAYMENT_CHOICE_NOT_FOUND')
      payload.pay_method_index = choiceIndex
    }
    delete payload.choice_id
    return sanitizeTopUpPayload('waffo', payload, redirect)
  }
  if (optionId === 'global-pancake') {
    return sanitizeTopUpPayload('waffo-pancake', { ...input }, redirect)
  }
  throw new ServiceError('Payment option is not available', 400, 'PAYMENT_OPTION_NOT_FOUND')
}

function rejectClientRedirectOverrides(input: Record<string, unknown>): void {
  if ('success_url' in input || 'cancel_url' in input || 'return_url' in input) {
    throw new ServiceError('Payment redirect is controlled by the Account Service', 400, 'PAYMENT_REDIRECT_OVERRIDE_FORBIDDEN')
  }
}

export function sanitizeSubscriptionPayload(
  provider: string,
  input: unknown,
): { provider: SubscriptionPaymentProvider; payload: Record<string, unknown> } {
  if (!isRecord(input)) throw invalidPaymentRequest()
  const normalizedProvider = asSubscriptionProvider(provider)
  const payload: Record<string, unknown> = { plan_id: requiredPositiveInteger(input.plan_id, 'plan_id') }
  if (normalizedProvider === 'epay') {
    payload.payment_method = requiredPaymentMethod(input.payment_method)
  }
  return { provider: normalizedProvider, payload }
}

function asTopUpProvider(value: string): TopUpProvider {
  if (topUpProviders.has(value as TopUpProvider)) return value as TopUpProvider
  throw new ServiceError('Payment provider is not supported', 404, 'PAYMENT_PROVIDER_NOT_FOUND')
}

function asSubscriptionProvider(value: string): SubscriptionPaymentProvider {
  if (subscriptionProviders.has(value as SubscriptionPaymentProvider)) return value as SubscriptionPaymentProvider
  throw new ServiceError('Payment provider is not supported', 404, 'PAYMENT_PROVIDER_NOT_FOUND')
}

function assertUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError('Invalid payment account', 502, 'PAYMENT_ACCOUNT_INVALID')
  }
}

function requiredAmount(value: unknown): number {
  return requiredPositiveInteger(value, 'amount', MAX_PAYMENT_AMOUNT)
}

function requiredPositiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw invalidPaymentRequest()
  }
  return value as number
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_PAYMENT_AMOUNT) {
    throw invalidPaymentRequest()
  }
  return value as number
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
    throw invalidPaymentRequest()
  }
  return value.trim()
}

function optionalText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) throw invalidPaymentRequest()
  return value.trim()
}

function requiredPaymentMethod(value: unknown): string {
  const method = requiredText(value, 'payment_method')
  if (!/^[a-z0-9_-]{1,32}$/i.test(method)) throw invalidPaymentRequest()
  return method
}

function requiredFixedPaymentMethod(value: unknown, expected: string): string {
  const method = requiredPaymentMethod(value)
  if (method !== expected) throw invalidPaymentRequest()
  return method
}

function invalidPaymentRequest(): ServiceError {
  return new ServiceError('Invalid payment request', 400, 'INVALID_PAYMENT_REQUEST')
}

function positivePage(value: number | undefined): number {
  if (value === undefined) return 1
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000 ? value : 1
}

function positivePageSize(value: number | undefined): number {
  if (value === undefined) return 10
  return Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : 10
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPaymentData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return isRecord(value.data) ? value.data : value
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function readNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(readNumber).filter((item): item is number => item !== undefined && item > 0) : []
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readProducts(value: unknown): Array<{ id: string; name: string; price: number; currency: string; quota: number }> {
  let source = value
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return []
    }
  }
  return readRecords(source).flatMap((item) => {
    const id = readString(item.productId ?? item.product_id)
    const name = readString(item.name)
    const price = readNumber(item.price)
    const currency = readString(item.currency)
    const quota = readNumber(item.quota)
    return id && name && price !== undefined && currency && quota !== undefined ? [{ id, name, price, currency, quota }] : []
  })
}

function readPublicOptions(value: unknown): PublicTopUpOption[] {
  return readRecords(value).flatMap((item) => {
    const id = readString(item.id)
    const name = readString(item.name)
    const kind = item.kind === 'product' ? 'product' : item.kind === 'amount' ? 'amount' : undefined
    if (!id || !name || !kind) return []
    const choices = readRecords(item.choices).flatMap((choice) => {
      const choiceId = readString(choice.id)
      const choiceName = readString(choice.name)
      return choiceId && choiceName ? [{ id: choiceId, name: choiceName }] : []
    })
    const products = readProducts(item.products)
    const minTopUp = readNumber(item.min_top_up ?? item.minTopUp)
    return [{
      id,
      name,
      kind,
      ...(minTopUp === undefined ? {} : { min_top_up: minTopUp }),
      ...(choices.length > 0 ? { choices } : {}),
      ...(products.length > 0 ? { products } : {}),
    }]
  })
}

function safePaymentErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'PAYMENT_REQUEST_FAILED'
}
