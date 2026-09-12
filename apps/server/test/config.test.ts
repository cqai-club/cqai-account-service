import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig, resolvePaymentRedirect } from '../src/config.js'

const validEnvironment: NodeJS.ProcessEnv = {
  DEBUG_AUTH_LOGS: '1',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000,https://lingweave.example.com',
  LOGTO_ISSUER: 'https://auth.example.com/oidc',
  LOGTO_AUDIENCE: 'https://account.example.com',
  LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
    'client-1': {
      platform: 'lingweave',
      client_type: 'web',
      redirects: {
        'http://localhost:3000': {
          success_url: 'http://localhost:3000/billing/result',
          cancel_url: 'http://localhost:3000/billing/result?status=cancelled',
        },
      },
    },
  }),
  LOGTO_ADMIN_SCOPE: 'account:admin',
  LOGTO_ROOT_SCOPE: 'account:root',
  NEW_API_BASE_URL: 'https://new-api.example.com',
  NEW_API_INTERNAL_TOKEN: 'secret',
  CLIENT_DEFAULT_MODEL: 'gpt-4o-mini',
}

test('loads and normalizes service configuration', () => {
  const config = loadConfig(validEnvironment)
  assert.equal(config.port, 8787)
  assert.equal(config.debugAuthLogs, true)
  assert.equal(config.logtoJwksUri, 'https://auth.example.com/oidc/jwks')
  const client = config.logtoClientPlatforms.get('client-1')
  assert.equal(client?.platform, 'lingweave')
  assert.equal(client?.clientType, 'web')
  assert.deepEqual(client?.webRedirects.get('http://localhost:3000'), {
    successUrl: 'http://localhost:3000/billing/result',
    cancelUrl: 'http://localhost:3000/billing/result?status=cancelled',
  })
  assert.equal(config.corsAllowedOrigins.has('http://localhost:3000'), true)
  assert.equal(config.logtoAdminScope, 'account:admin')
  assert.equal(config.logtoRootScope, 'account:root')
  assert.equal(config.clientDefaultModel, 'gpt-4o-mini')
})

test('allows minimal bootstrap without dynamic CORS or client mappings', () => {
  const { CORS_ALLOWED_ORIGINS: _origins, LOGTO_CLIENT_PLATFORM_MAP: _platforms, ...minimal } = validEnvironment
  const config = loadConfig(minimal)
  assert.deepEqual([...config.corsAllowedOrigins], [])
  assert.deepEqual([...config.logtoClientPlatforms], [])
  assert.deepEqual(config.logtoRequiredScopes, ['ai:invoke'])
})

test('allows the trusted-client default model to remain unset', () => {
  const { CLIENT_DEFAULT_MODEL: _model, ...minimal } = validEnvironment
  assert.equal(loadConfig(minimal).clientDefaultModel, '')
})

test('allows NewAPI settings to remain empty only when deployment can provision them', () => {
  const { NEW_API_BASE_URL: _baseUrl, NEW_API_INTERNAL_TOKEN: _token, ...minimal } = validEnvironment
  const config = loadConfig(minimal)
  assert.equal(config.newApiBaseUrl, '')
  assert.equal(config.newApiInternalToken, '')
  assert.equal(config.redisUrl, '')
})

test('rejects wildcard CORS configuration', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, CORS_ALLOWED_ORIGINS: '*' }),
    /must not contain \*/,
  )
})

test('parses admin/root scopes and rejects unsafe values', () => {
  const config = loadConfig(validEnvironment)
  assert.equal(config.logtoAdminScope, 'account:admin')
  assert.equal(config.logtoRootScope, 'account:root')
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_ADMIN_SCOPE: 'bad scope' }),
    /LOGTO_ADMIN_SCOPE must be a syntactically valid OAuth scope/,
  )
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_ROOT_SCOPE: '' }),
    /LOGTO_ROOT_SCOPE is required/,
  )
})

test('rejects malformed client mappings', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_CLIENT_PLATFORM_MAP: 'client-1=lingweave' }),
    /must be a JSON object/,
  )
})

test('parses a desktop client redirect without requiring a browser origin', () => {
  const config = loadConfig({
    ...validEnvironment,
    LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
      'desktop-client': {
        platform: 'cqai-desktop',
        client_type: 'desktop',
        redirects: {
          success_url: 'cqai://payment/result',
          cancel_url: 'cqai://payment/result?status=cancelled',
        },
      },
    }),
  })
  assert.deepEqual(config.logtoClientPlatforms.get('desktop-client')?.desktopRedirect, {
    successUrl: 'cqai://payment/result',
    cancelUrl: 'cqai://payment/result?status=cancelled',
  })
})

test('rejects payment redirect origins outside CORS configuration', () => {
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
        'client-1': {
          platform: 'lingweave',
          client_type: 'web',
          redirects: {
            'http://127.0.0.1:3003': { success_url: 'http://127.0.0.1:3003/billing/result' },
          },
        },
      }),
    }),
    /must be listed in CORS_ALLOWED_ORIGINS/,
  )
})

test('selects the exact web origin from multiple configured environments', () => {
  const config = loadConfig({
    ...validEnvironment,
    CORS_ALLOWED_ORIGINS: 'https://lingweave.example.com,http://127.0.0.1:3003,http://localhost:3003',
    LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
      'client-1': {
        platform: 'lingweave',
        client_type: 'web',
        redirects: {
          'https://lingweave.example.com': { success_url: 'https://lingweave.example.com/billing/result' },
          'http://127.0.0.1:3003': { success_url: 'http://127.0.0.1:3003/billing/result' },
          'http://localhost:3003': { success_url: 'http://localhost:3003/billing/result' },
        },
      },
    }),
  })
  const client = config.logtoClientPlatforms.get('client-1')
  assert.equal(resolvePaymentRedirect(client, 'https://lingweave.example.com').successUrl, 'https://lingweave.example.com/billing/result')
  assert.equal(resolvePaymentRedirect(client, 'http://127.0.0.1:3003').successUrl, 'http://127.0.0.1:3003/billing/result')
  assert.equal(resolvePaymentRedirect(client, 'http://localhost:3003').successUrl, 'http://localhost:3003/billing/result')
  assert.throws(() => resolvePaymentRedirect(client, 'http://localhost:3004'), /origin is not configured/)
})

test('rejects missing and unsafe payment redirect configuration', () => {
  assert.throws(() => resolvePaymentRedirect(undefined, 'https://lingweave.example.com'), /not configured for this client/)
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
        'client-1': {
          platform: 'lingweave',
          client_type: 'web',
          redirects: { 'http://localhost:3000': { success_url: 'javascript://alert(1)' } },
        },
      }),
    }),
    /must be a valid URL|forbidden scheme/,
  )
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
        'client-1': {
          platform: 'lingweave',
          client_type: 'web',
          redirects: { 'http://localhost:3000': { cancel_url: 'http://localhost:3000/billing/result' } },
        },
      }),
    }),
    /payment redirect success_url is required/,
  )
})

test('accepts only redis or rediss URLs', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, REDIS_URL: 'http://redis.example.com' }),
    /REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL/,
  )
  const config = loadConfig({ ...validEnvironment, REDIS_URL: 'redis://:password@127.0.0.1:6380/0' })
  assert.equal(config.redisUrl, 'redis://:password@127.0.0.1:6380/0')
})

test('requires at least one authorization scope', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_REQUIRED_SCOPES: '' }),
    /LOGTO_REQUIRED_SCOPES is empty/,
  )
})

test('rejects invalid diagnostic logging values', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, DEBUG_AUTH_LOGS: 'sometimes' }),
    /DEBUG_AUTH_LOGS must be a boolean/,
  )
})

test('reserves the internal admin platform marker', () => {
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      LOGTO_CLIENT_PLATFORM_MAP: JSON.stringify({
        'client-1': {
          platform: 'admin',
          client_type: 'web',
          redirects: { 'http://localhost:3000': { success_url: 'http://localhost:3000/billing/result' } },
        },
      }),
    }),
    /contains an invalid platform/,
  )
})
