// Process entrypoint. Loads + validates config (fails fast), builds the container and app,
// listens, and wires graceful shutdown. No business logic.

import { loadConfig } from './shared/config/index'
import { buildContainer } from './container'
import { buildApp } from './app'

const main = async (): Promise<void> => {
  const config = loadConfig()
  const container = await buildContainer(config)
  const app = await buildApp(container)

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void close('SIGINT'))
  process.on('SIGTERM', () => void close('SIGTERM'))

  await app.listen({ port: config.PORT, host: '0.0.0.0' })
}

main().catch((err: unknown) => {
  // Boot failures (invalid config, port in use) are fatal and must surface clearly.
  console.error('fatal: failed to start Praxis', err)
  process.exit(1)
})
