import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

const baseEnvironment: NodeJS.ProcessEnv = {
  CORS_ALLOWED_ORIGINS: 'https://admin.example.com',
  LOGTO_ISSUER: 'https://auth.example.com/oidc',
  LOGTO_AUDIENCE: 'https://account.example.com',
  LOGTO_CLIENT_PLATFORM_MAP: '{"customer-client":"lingweave"}',
  NEW_API_BASE_URL: 'https://new-api.example.com',
  NEW_API_INTERNAL_TOKEN: 'server-only-secret',
}

test('loads the Logto admin SPA metadata', () => {
  const config = loadConfig({
    ...baseEnvironment,
    LOGTO_ADMIN_CLIENT_ID: 'admin-client-a',
    LOGTO_ADMIN_REDIRECT_URI: 'https://admin.example.com/callback',
  })

  assert.equal(config.logtoAdminClientId, 'admin-client-a')
  assert.equal(config.logtoAdminRedirectUri, 'https://admin.example.com/callback')
})

test('loads the singular admin SPA client ID', () => {
  const config = loadConfig({
    ...baseEnvironment,
    LOGTO_ADMIN_CLIENT_ID: 'admin-client',
  })

  assert.equal(config.logtoAdminClientId, 'admin-client')
})

test('rejects an admin redirect URI with credentials or hash', () => {
  for (const redirectUri of [
    'https://user:pass@admin.example.com/callback',
    'https://admin.example.com/callback#fragment',
  ]) {
    assert.throws(
      () => loadConfig({ ...baseEnvironment, LOGTO_ADMIN_REDIRECT_URI: redirectUri }),
      /LOGTO_ADMIN_REDIRECT_URI must be an HTTP\(S\) URL without credentials or hash|LOGTO_ADMIN_REDIRECT_URI must be an absolute URL/,
    )
  }
})

test('ignores the removed plural admin client environment variable', () => {
  const config = loadConfig({
    ...baseEnvironment,
    LOGTO_ADMIN_CLIENT_IDS: 'admin-client-a admin-client-b',
    LOGTO_ADMIN_CLIENT_ID: 'admin-client-root',
  })
  assert.equal(config.logtoAdminClientId, 'admin-client-root')
})
