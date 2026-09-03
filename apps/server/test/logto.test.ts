import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'

import { ServiceError } from '../src/errors.js'
import { LogtoTokenVerifier } from '../src/logto.js'

const issuer = 'https://auth.example.com/oidc'
const audience = 'https://account.example.com'

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('ES384')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'test-key'
  publicJwk.alg = 'ES384'
  const config = {
    logtoIssuer: issuer,
    logtoAudience: audience,
    logtoJwksUri: `${issuer}/jwks`,
    logtoRequiredScopes: ['ai:invoke'],
    logtoClientPlatforms: new Map([['client-1', 'lingweave']]),
  }
  const verifier = new LogtoTokenVerifier(
    config,
    createLocalJWKSet({ keys: [publicJwk] }),
  )
  const sign = (
    claims: Record<string, unknown> = {},
    options: { expiration?: number | string | Date | null } = {},
  ) => {
    const token = new SignJWT({
      client_id: 'client-1',
      scope: 'openid ai:invoke',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES384', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('user-1')
      .setIssuedAt()
    if (options.expiration !== null) token.setExpirationTime(options.expiration ?? '5m')
    return token.sign(privateKey)
  }
  return { verifier, sign }
}

test('accepts a valid Logto API access token and maps its client', async () => {
  const { verifier, sign } = await fixture()
  const identity = await verifier.verify(await sign({ email: 'user@example.com', name: 'User' }))
  assert.deepEqual(identity, {
    issuer,
    subject: 'user-1',
    clientId: 'client-1',
    platform: 'lingweave',
    scopes: ['openid', 'ai:invoke'],
    email: 'user@example.com',
    name: 'User',
  })
})

test('rejects tokens without the required scope', async () => {
  const { verifier, sign } = await fixture()
  const token = await sign({ scope: 'openid' })
  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => error instanceof ServiceError && error.code === 'AUTH_SCOPE_FORBIDDEN',
  )
})

test('rejects tokens issued to an unregistered application', async () => {
  const { verifier, sign } = await fixture()
  const token = await sign({ client_id: 'unknown-client' })
  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => error instanceof ServiceError && error.code === 'AUTH_CLIENT_FORBIDDEN',
  )
})

test('rejects an access token without an expiration claim', async () => {
  const { verifier, sign } = await fixture()
  const token = await sign({}, { expiration: null })
  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => error instanceof ServiceError
      && error.status === 401
      && error.code === 'AUTH_CLAIMS_INVALID',
  )
})

test('rejects an expired access token', async () => {
  const { verifier, sign } = await fixture()
  const token = await sign({}, { expiration: Math.floor(Date.now() / 1000) - 60 })
  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => error instanceof ServiceError
      && error.status === 401
      && error.code === 'AUTH_TOKEN_INVALID',
  )
})

test('rejects conflicting client_id and azp claims', async () => {
  const { verifier, sign } = await fixture()
  const token = await sign({ client_id: 'client-1', azp: 'different-client' })
  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => error instanceof ServiceError
      && error.status === 401
      && error.code === 'AUTH_CLAIMS_INVALID',
  )
})
