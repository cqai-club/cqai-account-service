import { serve } from '@hono/node-server'

import { defaultAdminUiRoot } from './admin-assets.js'
import { NewApiAccountResolver } from './accounts.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { LogtoTokenVerifier } from './logto.js'
import { RuntimeConfigStore, runtimeConfigStorePath } from './runtime-config.js'

const config = loadConfig()
const storePath = runtimeConfigStorePath()
const runtimeConfig = await RuntimeConfigStore.fromConfig(config, {
  ...(storePath ? { path: storePath } : {}),
})
const app = createApp(config, {
  verifier: new LogtoTokenVerifier(config, undefined, () => runtimeConfig.getConfig()),
  accounts: new NewApiAccountResolver(config, undefined, runtimeConfig),
  runtimeConfig,
  adminUiRoot: defaultAdminUiRoot(),
})

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`CQAI Account Service listening on port ${port}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
