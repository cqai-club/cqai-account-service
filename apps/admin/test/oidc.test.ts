import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizationCodeTokenRequest,
  clearOidcEndpointsOnIssuerChange,
  normalizeOidcEndpoint,
  oidcIssuerMatches,
  pendingLoginIssuerMatches,
  pendingLoginServiceOriginMatches,
  selectOidcEndpoints,
  shouldResetOidcForServiceChange,
} from '../src/oidc.js'

test('keeps the API resource binding when exchanging an authorization code', () => {
  const body = authorizationCodeTokenRequest({
    clientId: 'admin-client',
    redirectUri: 'http://localhost:8789/admin/',
    code: 'test-code',
    codeVerifier: 'test-verifier',
    audience: 'https://account.example.com',
  })

  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('client_id'), 'admin-client')
  assert.equal(body.get('resource'), 'https://account.example.com')
  assert.equal(body.get('code'), 'test-code')
  assert.equal(body.get('code_verifier'), 'test-verifier')
})

test('only reuses cached OIDC endpoints for the same issuer', () => {
  const cached = {
    issuer: 'https://auth.example.com/oidc',
    authorizationEndpoint: 'https://auth.example.com/oidc/auth',
    tokenEndpoint: 'https://auth.example.com/oidc/token',
  }

  assert.deepEqual(
    selectOidcEndpoints('https://auth.example.com/oidc/', {}, cached),
    {
      authorizationEndpoint: cached.authorizationEndpoint,
      tokenEndpoint: cached.tokenEndpoint,
    },
  )
  assert.deepEqual(
    selectOidcEndpoints('https://other-auth.example.com/oidc', {}, cached),
    {},
  )
})

test('fresh discovery endpoints win over cached endpoints', () => {
  const selected = selectOidcEndpoints(
    'https://auth.example.com/oidc',
    {
      authorization_endpoint: 'https://auth.example.com/oidc/v2/auth',
      token_endpoint: 'https://auth.example.com/oidc/v2/token',
    },
    {
      issuer: 'https://auth.example.com/oidc',
      authorizationEndpoint: 'https://auth.example.com/oidc/old-auth',
      tokenEndpoint: 'https://auth.example.com/oidc/old-token',
    },
  )

  assert.deepEqual(selected, {
    authorizationEndpoint: 'https://auth.example.com/oidc/v2/auth',
    tokenEndpoint: 'https://auth.example.com/oidc/v2/token',
  })
})

test('clears endpoint cache when the operator changes issuer', () => {
  const changed = clearOidcEndpointsOnIssuerChange(
    {
      issuer: 'https://auth.example.com/oidc',
      authorizationEndpoint: 'https://auth.example.com/oidc/auth',
      tokenEndpoint: 'https://auth.example.com/oidc/token',
    },
    'https://other-auth.example.com/oidc',
  )

  assert.deepEqual(changed, { issuer: 'https://other-auth.example.com/oidc' })
  assert.equal(oidcIssuerMatches('https://auth.example.com/oidc/', 'https://auth.example.com/oidc'), true)
  assert.equal(oidcIssuerMatches('https://auth.example.com/oidc', 'https://other-auth.example.com/oidc'), false)
})

test('does not trust endpoint cache without issuer provenance', () => {
  assert.deepEqual(
    selectOidcEndpoints(
      'https://auth.example.com/oidc',
      {},
      {
        authorizationEndpoint: 'https://unknown.example.com/auth',
        tokenEndpoint: 'https://unknown.example.com/token',
      },
    ),
    {},
  )
})

test('accepts only absolute HTTP(S) OIDC endpoints without credentials or fragments', () => {
  assert.equal(
    normalizeOidcEndpoint('https://auth.example.com/token?tenant=main'),
    'https://auth.example.com/token?tenant=main',
  )
  for (const value of [
    'javascript:alert(1)',
    'data:text/plain,token',
    '/relative/token',
    'https://user:pass@auth.example.com/token',
    'https://auth.example.com/token#fragment',
    'not a URL',
    '',
    null,
  ]) {
    assert.equal(normalizeOidcEndpoint(value), undefined, String(value))
  }
})

test('filters malicious discovery and cached endpoints', () => {
  const cached = {
    issuer: 'https://auth.example.com/oidc',
    authorizationEndpoint: 'javascript:alert(1)',
    tokenEndpoint: 'https://user:pass@auth.example.com/token',
  }
  assert.deepEqual(
    selectOidcEndpoints(
      'https://auth.example.com/oidc',
      {
        authorization_endpoint: 'data:text/plain,login',
        token_endpoint: 'https://auth.example.com/token#bad',
      },
      cached,
    ),
    {},
  )
})

test('does not redeem a pending login code after the issuer changes', () => {
  assert.equal(
    pendingLoginIssuerMatches('https://auth.example.com/oidc/', 'https://auth.example.com/oidc'),
    true,
  )
  assert.equal(
    pendingLoginIssuerMatches('https://other-auth.example.com/oidc', 'https://auth.example.com/oidc'),
    false,
  )
  assert.equal(pendingLoginIssuerMatches(undefined, 'https://auth.example.com/oidc'), false)
  assert.equal(pendingLoginIssuerMatches('https://auth.example.com/oidc', undefined), false)
})

test('does not redeem a pending login code after the service origin changes', () => {
  assert.equal(
    pendingLoginServiceOriginMatches('https://account.example.com/', 'https://account.example.com'),
    true,
  )
  assert.equal(
    pendingLoginServiceOriginMatches('https://other-account.example.com', 'https://account.example.com'),
    false,
  )
  assert.equal(pendingLoginServiceOriginMatches(undefined, 'https://account.example.com'), false)
  assert.equal(pendingLoginServiceOriginMatches('https://account.example.com', undefined), false)
  assert.equal(pendingLoginServiceOriginMatches('not-a-url', 'https://account.example.com'), false)
})

test('resets service-specific OIDC state when selecting a new service', () => {
  assert.equal(shouldResetOidcForServiceChange(false, false), true)
  assert.equal(shouldResetOidcForServiceChange(false, true), true)
  assert.equal(shouldResetOidcForServiceChange(true, true), true)
  assert.equal(shouldResetOidcForServiceChange(true, false), false)
})
