import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'

import { ServiceError } from '../src/errors.js'
import { LogtoTokenVerifier } from '../src/logto.js'

const issuer = 'https://auth.example.com/oidc'
const audience = 'https://account.example.com'
const adminClientId = 'admin-client'

/**
 * Build a verifier with a local JWKS so these tests exercise the same
 * signature/issuer/audience checks used in production without network I/O.
 */
async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('ES384')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'admin-auth-test-key'
  publicJwk.alg = 'ES384'

  const verifier = new LogtoTokenVerifier(
    {
      logtoIssuer: issuer,
      logtoAudience: audience,
      logtoJwksUri: `${issuer}/jwks`,
      logtoRequiredScopes: ['ai:invoke'],
      logtoClientPlatforms: new Map([['customer-client', 'lingweave']]),
      logtoAdminClientId: adminClientId,
    },
    createLocalJWKSet({ keys: [publicJwk] }),
  )

  const sign = async (claims: Record<string, unknown> = {}) => new SignJWT({
    client_id: 'customer-client',
    scope: 'openid ai:invoke',
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES384', kid: 'admin-auth-test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)

  return { verifier, sign }
}

test('route-specific admin scope replaces the normal AI scope requirement', async () => {
  const { verifier, sign } = await fixture()
  const adminToken = await sign({ scope: 'openid config:read', client_id: 'admin-client' })

  const identity = await verifier.verify(adminToken, {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })

  assert.equal(identity.clientId, 'admin-client')
  assert.equal(identity.platform, 'admin')
  assert.deepEqual(identity.scopes, ['openid', 'config:read'])
})

test('a normal AI token cannot satisfy an admin route', async () => {
  const { verifier, sign } = await fixture()
  const adminClientToken = await sign({ scope: 'openid ai:invoke', client_id: 'admin-client' })

  await assert.rejects(
    () => verifier.verify(adminClientToken, {
      requiredScopes: ['config:read'],
      adminRoute: true,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === 'AUTH_SCOPE_FORBIDDEN',
  )
})

test('any verified Logto client with the read scope can access the admin route', async () => {
  const { verifier, sign } = await fixture()
  const customerToken = await sign({ scope: 'openid config:read' })

  const identity = await verifier.verify(customerToken, {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })
  assert.equal(identity.clientId, 'customer-client')
  assert.equal(identity.platform, 'admin')
})

test('a client with read scope still needs the route-specific write scope', async () => {
  const { verifier, sign } = await fixture()
  const adminToken = await sign({ scope: 'openid config:read', client_id: 'admin-client' })

  await assert.rejects(
    () => verifier.verify(adminToken, {
      requiredScopes: ['config:write'],
      adminRoute: true,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === 'AUTH_SCOPE_FORBIDDEN',
  )
})

test('an admin client is isolated from customer platform mappings', async () => {
  const { verifier, sign } = await fixture()
  const adminToken = await sign({ scope: 'config:read', client_id: 'admin-client' })

  const identity = await verifier.verify(adminToken, {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })

  // The admin route receives an internal marker, never a caller-selected
  // customer platform. This prevents an admin token from being reused for
  // customer account provisioning or quota lookup.
  assert.equal(identity.platform, 'admin')
  assert.notEqual(identity.platform, 'lingweave')
})

test('an admin route keeps the admin marker even if the client has a customer mapping', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES384')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'admin-auth-overlap-key'
  publicJwk.alg = 'ES384'
  const verifier = new LogtoTokenVerifier(
    {
      logtoIssuer: issuer,
      logtoAudience: audience,
      logtoJwksUri: `${issuer}/jwks`,
      logtoRequiredScopes: ['ai:invoke'],
      logtoAdminClientId: adminClientId,
      // This overlap is a configuration mistake; the admin route must still
      // never turn an admin token into a customer platform identity.
      logtoClientPlatforms: new Map([
        ['customer-client', 'lingweave'],
        ['admin-client', 'lingweave'],
      ]),
    },
    createLocalJWKSet({ keys: [publicJwk] }),
  )
  const adminToken = await new SignJWT({ client_id: 'admin-client', scope: 'config:read' })
    .setProtectedHeader({ alg: 'ES384', kid: 'admin-auth-overlap-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('admin-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)

  const identity = await verifier.verify(adminToken, {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })
  assert.equal(identity.platform, 'admin')
})

function introspectionResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    iss: issuer,
    aud: audience,
    sub: 'admin-user',
    client_id: adminClientId,
    scope: 'openid config:read config:write',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }
}

async function opaqueVerifier(
  responseBody: Record<string, unknown>,
  observe?: (input: string | URL | Request, init?: RequestInit) => void,
): Promise<LogtoTokenVerifier> {
  const { publicKey } = await generateKeyPair('ES384')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'opaque-admin-test-key'
  publicJwk.alg = 'ES384'
  return new LogtoTokenVerifier(
    {
      logtoIssuer: issuer,
      logtoAudience: audience,
      logtoJwksUri: `${issuer}/jwks`,
      logtoRequiredScopes: ['ai:invoke'],
      logtoClientPlatforms: new Map([['customer-client', 'lingweave']]),
      logtoAdminClientId: adminClientId,
    },
    createLocalJWKSet({ keys: [publicJwk] }),
    undefined,
    async (input, init) => {
      observe?.(input, init)
      return Response.json(responseBody)
    },
  )
}

test('an active opaque Logto token can authorize an admin route through introspection', async () => {
  let requestBody: URLSearchParams | undefined
  const verifier = await opaqueVerifier(introspectionResponse(), (input, init) => {
    assert.equal(input.toString(), `${issuer}/token/introspection`)
    assert.equal(init?.method, 'POST')
    requestBody = init?.body as URLSearchParams
  })

  const identity = await verifier.verify('opaque-test-token', {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })

  assert.equal(requestBody?.get('token'), 'opaque-test-token')
  assert.equal(requestBody?.get('client_id'), adminClientId)
  assert.equal(identity.subject, 'admin-user')
  assert.equal(identity.clientId, adminClientId)
  assert.equal(identity.platform, 'admin')
})

test('the configured introspection endpoint establishes issuer when Logto omits iss', async () => {
  const response = introspectionResponse()
  delete response.iss
  const verifier = await opaqueVerifier(response)

  const identity = await verifier.verify('opaque-test-token', {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })

  assert.equal(identity.issuer, issuer)
})

test('Logto resource metadata establishes the opaque token audience', async () => {
  const response = introspectionResponse({ resource: audience })
  delete response.aud
  const verifier = await opaqueVerifier(response)

  const identity = await verifier.verify('opaque-test-token', {
    requiredScopes: ['config:read'],
    adminRoute: true,
  })

  assert.equal(identity.platform, 'admin')
})

test('an opaque token is never introspected for a customer route', async () => {
  let called = false
  const verifier = await opaqueVerifier(introspectionResponse(), () => {
    called = true
  })

  await assert.rejects(
    () => verifier.verify('opaque-test-token'),
    (error: unknown) => error instanceof ServiceError && error.code === 'AUTH_TOKEN_INVALID',
  )
  assert.equal(called, false)
})

test('inactive opaque tokens are rejected', async () => {
  const verifier = await opaqueVerifier({ active: false })
  await assert.rejects(
    () => verifier.verify('opaque-test-token', { requiredScopes: ['config:read'], adminRoute: true }),
    (error: unknown) => error instanceof ServiceError
      && error.status === 401
      && error.code === 'AUTH_TOKEN_INVALID',
  )
})

for (const [name, overrides] of [
  ['issuer', { iss: 'https://other.example.com/oidc' }],
  ['audience', { aud: 'https://other.example.com' }],
  ['expiration', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ['client', { client_id: 'different-client' }],
] as const) {
  test(`opaque token introspection rejects an invalid ${name}`, async () => {
    const verifier = await opaqueVerifier(introspectionResponse(overrides))
    await assert.rejects(
      () => verifier.verify('opaque-test-token', { requiredScopes: ['config:read'], adminRoute: true }),
      (error: unknown) => error instanceof ServiceError && error.status === 401,
    )
  })
}

test('opaque token introspection still enforces the route-specific scope', async () => {
  const verifier = await opaqueVerifier(introspectionResponse({ scope: 'openid config:read' }))
  await assert.rejects(
    () => verifier.verify('opaque-test-token', { requiredScopes: ['config:write'], adminRoute: true }),
    (error: unknown) => error instanceof ServiceError
      && error.status === 403
      && error.code === 'AUTH_SCOPE_FORBIDDEN',
  )
})
