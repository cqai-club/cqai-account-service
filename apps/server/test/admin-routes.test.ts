import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApp } from '../src/app.js'
import type { ServiceConfig } from '../src/config.js'
import { RuntimeConfigStore } from '../src/runtime-config.js'
import type { AccountResolver, TokenVerificationOptions, TokenVerifier, VerifiedIdentity } from '../src/types.js'

const config: ServiceConfig = {
  port: 8787,
  corsAllowedOrigins: new Set(['https://admin.example.com']),
  logtoIssuer: 'https://auth.example.com/oidc',
  logtoAudience: 'https://account.example.com',
  logtoJwksUri: 'https://auth.example.com/oidc/jwks',
  logtoRequiredScopes: ['ai:invoke'],
  logtoClientPlatforms: new Map([['customer-client', 'lingweave']]),
  logtoAdminClientId: 'admin-client',
  logtoAdminRedirectUri: 'https://admin.example.com/callback',
  newApiBaseUrl: 'https://new-api.example.com',
  newApiInternalToken: 'server-only-new-api-secret',
  accountCacheTtlMs: 300_000,
  maxRequestBodyBytes: 20_971_520,
}

const adminIdentity: VerifiedIdentity = {
  issuer: config.logtoIssuer,
  subject: 'admin-user',
  clientId: 'admin-client',
  platform: 'admin',
  scopes: ['openid', 'config:read', 'config:write'],
}

function fixture() {
  const calls: Array<{ token: string; options: TokenVerificationOptions | undefined }> = []
  const verifier: TokenVerifier = {
    async verify(token, options) {
      calls.push({ token, options })
      return adminIdentity
    },
  }
  const accounts: AccountResolver = {
    async resolve() {
      throw new Error('account resolver must not run for admin config routes')
    },
  }
  const runtimeConfig = new RuntimeConfigStore(config)
  const app = createApp(config, { verifier, accounts, runtimeConfig })
  return { app, calls, runtimeConfig }
}

test('admin configuration endpoints still require a bearer token', async () => {
  const { app, calls } = fixture()
  const response = await app.request('/api/admin/config')

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'AUTH_TOKEN_REQUIRED',
    message: 'Bearer access token is required',
  })
  assert.equal(calls.length, 0)
})

test('admin routes do not require a Client ID allowlist', async () => {
  const { calls } = fixture()
  const configWithoutAllowlist: ServiceConfig = {
    ...config,
  }
  const runtimeConfig = new RuntimeConfigStore(configWithoutAllowlist)
  const app = createApp(configWithoutAllowlist, {
    verifier: {
      async verify(token, options) {
        calls.push({ token, options })
        return adminIdentity
      },
    },
    accounts: {
      async resolve() {
        throw new Error('account resolver must not run for admin config routes')
      },
    },
    runtimeConfig,
  })

  const response = await app.request('/api/admin/config', {
    headers: { Authorization: 'Bearer admin-token' },
  })
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
})

test('admin GET uses config:read and returns a secret-free configuration', async () => {
  const { app, calls } = fixture()
  const response = await app.request('/api/admin/config', {
    headers: { Authorization: 'Bearer admin-token' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls, [{
    token: 'admin-token',
    options: {
      requiredScopes: ['config:read'],
      adminRoute: true,
    },
  }])
  const body = await response.text()
  assert.doesNotMatch(body, /server-only-new-api-secret/)
  assert.doesNotMatch(body, /newApiInternalToken/)
  assert.match(body, /newApiBaseUrl/)
  assert.deepEqual(JSON.parse(body).data, {
    version: 1,
    updatedAt: JSON.parse(body).data.updatedAt,
    corsAllowedOrigins: ['https://admin.example.com'],
    logtoRequiredScopes: ['ai:invoke'],
    logtoClientPlatforms: { 'customer-client': 'lingweave' },
    accountCacheTtlSeconds: 300,
    maxRequestBodyBytes: 20_971_520,
    newApiBaseUrl: 'https://new-api.example.com',
    persistence: { enabled: false },
  })
})

test('admin PUT uses config:write and rejects attempts to submit a secret', async () => {
  const { app, calls, runtimeConfig } = fixture()
  const response = await app.request('/api/admin/config', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      accountCacheTtlSeconds: 60,
      newApiInternalToken: 'attacker-supplied-secret',
    }),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(calls[0], {
    token: 'admin-token',
    options: {
      requiredScopes: ['config:write'],
      adminRoute: true,
    },
  })
  const body = await response.text()
  assert.doesNotMatch(body, /attacker-supplied-secret/)
  assert.equal(runtimeConfig.getConfig().newApiInternalToken, 'server-only-new-api-secret')
})

test('admin validate uses config:write but does not publish or persist changes', async () => {
  const { app, calls, runtimeConfig } = fixture()
  const response = await app.request('/api/admin/config/validate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version: 1, accountCacheTtlSeconds: 60 }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls[0], {
    token: 'admin-token',
    options: {
      requiredScopes: ['config:write'],
      adminRoute: true,
    },
  })
  assert.deepEqual(await response.json(), {
    success: true,
    data: {
      valid: true,
      version: 1,
      updatedAt: (runtimeConfig.getPublicConfig() as { updatedAt: string }).updatedAt,
    },
  })
  assert.equal(runtimeConfig.getConfig().accountCacheTtlMs, 300_000)
})

test('admin configuration body limits preserve the 413 error contract', async () => {
  const { app } = fixture()
  const oversized = JSON.stringify({ accountCacheTtlSeconds: 60 }) + ' '.repeat(1_048_576)
  const response = await app.request('/api/admin/config/validate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
    },
    body: oversized,
  })

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'REQUEST_BODY_TOO_LARGE',
    message: 'Request body is too large',
  })
})

test('OIDC bootstrap metadata exposes no client secret or NewAPI credential', async () => {
  const { app } = fixture()
  const response = await app.request('/admin/oidc-config')

  assert.equal(response.status, 200)
  const body = await response.text()
  assert.doesNotMatch(body, /server-only-new-api-secret/)
  assert.doesNotMatch(body, /clientSecret/i)
  assert.deepEqual(JSON.parse(body), {
    success: true,
    data: {
      issuer: 'https://auth.example.com/oidc',
      audience: 'https://account.example.com',
      scopes: ['openid', 'config:read', 'config:write'],
      clientId: 'admin-client',
      redirectUri: 'https://admin.example.com/callback',
    },
  })
})

test('same-origin admin asset routes serve the built UI when configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cqai-admin-route-assets-'))
  try {
    await Promise.all([
      fs.writeFile(join(root, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>'),
      fs.writeFile(join(root, 'main.js'), 'console.log("admin")'),
      fs.writeFile(join(root, 'oidc.js'), 'export const issuer = "admin"'),
      fs.writeFile(join(root, 'styles.css'), 'body{}'),
    ])
    // Recreate the app with the temporary built-asset root to avoid depending
    // on a prior frontend build in this server test.
    const appWithUi = createApp(config, {
      verifier: {
        async verify() {
          return adminIdentity
        },
      },
      accounts: {
        async resolve() {
          throw new Error('account resolver must not run for static assets')
        },
      },
      runtimeConfig: new RuntimeConfigStore(config),
      adminUiRoot: root,
    })
    const html = await appWithUi.request('/admin/')
    assert.equal(html.status, 200)
    assert.equal(html.headers.get('content-type'), 'text/html; charset=UTF-8')
    assert.match(await html.text(), /main\.js/)
    const script = await appWithUi.request('/admin/main.js')
    assert.equal(script.status, 200)
    assert.match(await script.text(), /console\.log/)
    const oidcScript = await appWithUi.request('/admin/oidc.js')
    assert.equal(oidcScript.status, 200)
    assert.match(await oidcScript.text(), /export const issuer/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
