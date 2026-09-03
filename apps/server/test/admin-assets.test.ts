import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adminAssetResponse } from '../src/admin-assets.js'

test('serves only fixed admin assets with safe content types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cqai-admin-assets-'))
  try {
    await fs.writeFile(join(root, 'index.html'), '<!doctype html><title>admin</title>')
    await fs.writeFile(join(root, 'main.js'), 'console.log("ok")')
    await fs.writeFile(join(root, 'oidc.js'), 'export const issuer = "ok"')
    await fs.writeFile(join(root, 'styles.css'), 'body{color:black}')

    const html = await adminAssetResponse(root, 'index.html')
    assert.equal(html.status, 200)
    assert.equal(html.headers.get('content-type'), 'text/html; charset=UTF-8')
    assert.equal(html.headers.get('cache-control'), 'no-store')
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await html.text(), /admin/)

    const script = await adminAssetResponse(root, 'main.js')
    assert.equal(script.status, 200)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=UTF-8')
    assert.equal(script.headers.get('cache-control'), 'no-store')
    assert.match(await script.text(), /console/)

    const oidcScript = await adminAssetResponse(root, 'oidc.js')
    assert.equal(oidcScript.status, 200)
    assert.equal(oidcScript.headers.get('content-type'), 'text/javascript; charset=UTF-8')
    assert.match(await oidcScript.text(), /export/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('returns a bounded 404 when the admin UI has not been built', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cqai-admin-assets-missing-'))
  try {
    const response = await adminAssetResponse(root, 'index.html')
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=UTF-8')
    assert.match(await response.text(), /Admin UI is not built/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
