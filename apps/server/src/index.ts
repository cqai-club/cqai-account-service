import { serve } from '@hono/node-server'

import { NewApiAccountResolver } from './accounts.js'
import { createApp } from './app.js'
import { createAccountCache } from './cache.js'
import { loadConfig } from './config.js'
import { debugLog } from './diagnostics.js'
import { LogtoTokenVerifier } from './logto.js'

const config = loadConfig()
debugLog(config.debugAuthLogs, 'service.config_loaded', {
  port: config.port,
  logtoIssuer: config.logtoIssuer,
  logtoAudience: config.logtoAudience,
  requiredScopes: config.logtoRequiredScopes,
  mappedClientCount: config.logtoClientPlatforms.size,
  newApiConfigured: Boolean(config.newApiBaseUrl && config.newApiInternalToken),
})
const accountCache = await createAccountCache(config)
const app = createApp(config, {
  verifier: new LogtoTokenVerifier(config),
  accounts: new NewApiAccountResolver(config, undefined, accountCache),
})

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`CQAI Account Service listening on port ${port}`)
})

const shutdown = () => {
  server.close(() => {
    accountCache.close().finally(() => process.exit(0))
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
