import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

const validEnvironment: NodeJS.ProcessEnv = {
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000,https://lingweave.example.com',
  LOGTO_ISSUER: 'https://auth.example.com/oidc',
  LOGTO_AUDIENCE: 'https://account.example.com',
  LOGTO_CLIENT_PLATFORM_MAP: '{"client-1":"lingweave"}',
  LOGTO_ADMIN_SCOPE: 'account:admin',
  LOGTO_ROOT_SCOPE: 'account:root',
  NEW_API_BASE_URL: 'https://new-api.example.com',
  NEW_API_INTERNAL_TOKEN: 'secret',
  CLIENT_DEFAULT_MODEL: 'gpt-4o-mini',
}

test('loads and normalizes service configuration', () => {
  const config = loadConfig(validEnvironment)
  assert.equal(config.port, 8787)
  assert.equal(config.logtoJwksUri, 'https://auth.example.com/oidc/jwks')
  assert.equal(config.logtoClientPlatforms.get('client-1'), 'lingweave')
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

test('reserves the internal admin platform marker', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_CLIENT_PLATFORM_MAP: '{"client-1":"admin"}' }),
    /contains an invalid entry/,
  )
})
