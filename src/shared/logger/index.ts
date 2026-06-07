import { pino, type Logger } from 'pino'
import type { Config } from '../config/index'

export type { Logger }

export const createLogger = (config: Config): Logger => {
  const usePretty = config.NODE_ENV === 'development'
  return pino({
    level: config.LOG_LEVEL,
    ...(usePretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  })
}
