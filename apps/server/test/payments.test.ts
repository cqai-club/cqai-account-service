import assert from 'node:assert/strict'
import test from 'node:test'

import { NewApiPaymentService, normalizeTopUpInfo, resolveTopUpRequest, sanitizeSubscriptionPayload, sanitizeTopUpPayload } from '../src/payments.js'
import type { ServiceConfig } from '../src/config.js'

const config: Pick<ServiceConfig, 'newApiBaseUrl' | 'newApiInternalToken' | 'debugAuthLogs'> = {
  newApiBaseUrl: 'https://relay.example.com',
  newApiInternalToken: 'internal-secret',
  debugAuthLogs: false,
}

const paymentRedirect = {
  successUrl: 'https://app.example.com/billing/result',
  cancelUrl: 'cqai://payment/result?status=cancelled',
}

test('creates a Relay top-up request with the server-only internal token', async () => {
  let captured: Request | undefined
  const payments = new NewApiPaymentService(config, async (input, init) => {
    captured = new Request(input, init)
    return Response.json({
      success: true,
      data: { pay_link: 'https://pay.example/checkout', order_id: 'order-1' },
    })
  })

  const result = await payments.createTopUp(42, 'stripe', {
    amount: 100,
    payment_method: 'stripe',
  })

  assert.deepEqual(result.data, { pay_link: 'https://pay.example/checkout', order_id: 'order-1' })
  assert.equal(captured?.url, 'https://relay.example.com/api/internal/payment/topup/stripe')
  assert.equal(captured?.headers.get('authorization'), 'Bearer internal-secret')
  assert.deepEqual(JSON.parse(await captured!.text()), {
    user_id: 42,
    payload: { amount: 100, payment_method: 'stripe' },
  })
})

test('maps a Relay payment business failure to a stable service error', async () => {
  const payments = new NewApiPaymentService(config, async () => Response.json({
    message: 'error',
    data: '支付未配置',
  }))

  await assert.rejects(
    () => payments.createTopUp(42, 'stripe', { amount: 100, payment_method: 'stripe' }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 502)
      assert.equal((error as { code?: string }).code, 'PAYMENT_REQUEST_FAILED')
      return true
    },
  )
})

test('sanitizes payment payloads with Account Service redirect fields', () => {
  assert.deepEqual(
    sanitizeTopUpPayload('stripe', {
      amount: 100,
      payment_method: 'stripe',
    }, paymentRedirect),
    {
      provider: 'stripe',
      payload: {
        amount: 100,
        payment_method: 'stripe',
        success_url: 'https://app.example.com/billing/result',
        cancel_url: 'cqai://payment/result?status=cancelled',
      },
    },
  )
  assert.deepEqual(sanitizeTopUpPayload('epay', {
    amount: 100,
    payment_method: 'alipay',
  }, { successUrl: 'cqai://payment/result' }), {
    provider: 'epay',
    payload: { amount: 100, payment_method: 'alipay', return_url: 'cqai://payment/result' },
  })
  assert.deepEqual(sanitizeSubscriptionPayload('stripe', { plan_id: 3 }), {
    provider: 'stripe',
    payload: { plan_id: 3 },
  })
  assert.throws(
    () => sanitizeTopUpPayload('stripe', { amount: 100_000_001, payment_method: 'stripe' }, paymentRedirect),
    /Invalid payment request/,
  )
})

test('normalizes provider settings and resolves a provider-neutral top-up request', () => {
  const relayInfo = {
    data: {
      enable_online_topup: true,
      pay_methods: [
        { name: '支付宝', type: 'alipay' },
        { name: 'Stripe', type: 'stripe' },
        { name: 'Waffo', type: 'waffo' },
        { name: 'Pancake', type: 'waffo_pancake' },
      ],
      enable_stripe_topup: true,
      stripe_min_topup: 10,
      enable_waffo_topup: true,
      waffo_pay_methods: [{ name: '银行卡' }],
    },
  }

  assert.deepEqual(normalizeTopUpInfo(relayInfo), {
    payment_options: [
      { id: 'online-alipay', name: '支付宝', kind: 'amount' },
      { id: 'card', name: 'Stripe', kind: 'amount', min_top_up: 10 },
      { id: 'global', name: 'Waffo', kind: 'amount', choices: [{ id: '0', name: '银行卡' }] },
    ],
    amount_options: [],
  })
  assert.deepEqual(resolveTopUpRequest(relayInfo, {
    payment_option_id: 'card',
    amount: 100,
  }, paymentRedirect), {
    provider: 'stripe',
    payload: {
      amount: 100,
      payment_method: 'stripe',
      success_url: 'https://app.example.com/billing/result',
      cancel_url: 'cqai://payment/result?status=cancelled',
    },
  })
  assert.deepEqual(resolveTopUpRequest(relayInfo, {
    payment_option_id: 'online-alipay',
    amount: 20,
  }, { successUrl: 'https://app.example.com/billing/result' }), {
    provider: 'epay',
    payload: {
      amount: 20,
      payment_method: 'alipay',
      return_url: 'https://app.example.com/billing/result',
    },
  })
})

test('does not expose Epay methods when disabled or reinterpret independent gateways as Epay', () => {
  assert.deepEqual(normalizeTopUpInfo({
    data: {
      enable_online_topup: false,
      pay_methods: [{ name: '支付宝', type: 'alipay' }, { name: 'Stripe', type: 'stripe' }],
      enable_stripe_topup: true,
    },
  }), {
    payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }],
    amount_options: [],
  })
})

test('rejects client-supplied redirect overrides', () => {
  assert.throws(
    () => resolveTopUpRequest(
      { data: { payment_options: [{ id: 'card', name: 'Stripe', kind: 'amount' }] } },
      { payment_option_id: 'card', amount: 100, success_url: 'https://evil.example.com/result' },
      paymentRedirect,
    ),
    /Payment redirect is controlled by the Account Service/,
  )
})
