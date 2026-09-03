import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTENT_TYPES: Record<'index.html' | 'styles.css' | 'main.js' | 'oidc.js' | 'main.js.map' | 'oidc.js.map', string> = {
  'index.html': 'text/html; charset=UTF-8',
  'styles.css': 'text/css; charset=UTF-8',
  'main.js': 'text/javascript; charset=UTF-8',
  'oidc.js': 'text/javascript; charset=UTF-8',
  'main.js.map': 'application/json; charset=UTF-8',
  'oidc.js.map': 'application/json; charset=UTF-8',
}

/**
 * Resolve the built standalone admin page without making the browser choose a
 * filesystem path. Deployments may override the location with the
 * server-owned ADMIN_UI_DIR environment variable.
 */
export function defaultAdminUiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADMIN_UI_DIR?.trim()
  if (configured) return resolve(configured)
  // Works from both `src` under tsx and `dist` after the server build:
  // apps/server/{src,dist}/admin-assets.js -> apps/admin/dist.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist')
}

/** Return a fixed, content-typed asset or a safe 404 response. */
export async function adminAssetResponse(root: string, asset: keyof typeof CONTENT_TYPES): Promise<Response> {
  try {
    const body = await fs.readFile(resolve(root, asset))
    const contentType = CONTENT_TYPES[asset]!
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https:",
      },
    })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return new Response('Admin UI is not built. Run npm run build --workspace=@cqaiclub/account-admin.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      })
    }
    return new Response('Admin UI is unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    })
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
