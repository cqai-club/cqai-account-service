import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

const validEnvironment: NodeJS.ProcessEnv = {
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000,https://lingweave.example.com',
  LOGTO_ISSUER: 'https://auth.example.com/oidc',
  LOGTO_AUDIENCE: 'https://account.example.com',
  LOGTO_CLIENT_PLATFORM_MAP: '{"client-1":"lingweave"}',
  NEW_API_BASE_URL: 'https://new-api.example.com',
  NEW_API_INTERNAL_TOKEN: 'secret',
}

test('loads and normalizes service configuration', () => {
  const config = loadConfig(validEnvironment)
  assert.equal(config.port, 8787)
  assert.equal(config.logtoJwksUri, 'https://auth.example.com/oidc/jwks')
  assert.equal(config.logtoClientPlatforms.get('client-1'), 'lingweave')
  assert.equal(config.corsAllowedOrigins.has('http://localhost:3000'), true)
})

test('allows minimal bootstrap without dynamic CORS or client mappings', () => {
  const { CORS_ALLOWED_ORIGINS: _origins, LOGTO_CLIENT_PLATFORM_MAP: _platforms, ...minimal } = validEnvironment
  const config = loadConfig(minimal)
  assert.deepEqual([...config.corsAllowedOrigins], [])
  assert.deepEqual([...config.logtoClientPlatforms], [])
  assert.deepEqual(config.logtoRequiredScopes, ['ai:invoke'])
})

test('allows NewAPI settings to be configured later from the admin page', () => {
  const { NEW_API_BASE_URL: _baseUrl, NEW_API_INTERNAL_TOKEN: _token, ...minimal } = validEnvironment
  const config = loadConfig(minimal)
  assert.equal(config.newApiBaseUrl, '')
  assert.equal(config.newApiInternalToken, '')
})

test('rejects wildcard CORS configuration', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, CORS_ALLOWED_ORIGINS: '*' }),
    /must not contain \*/,
  )
})

test('rejects malformed client mappings', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, LOGTO_CLIENT_PLATFORM_MAP: 'client-1=lingweave' }),
    /must be a JSON object/,
  )
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
