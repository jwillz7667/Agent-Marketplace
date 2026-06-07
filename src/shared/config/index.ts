import { z } from 'zod'

// Boundary validation of process.env. Fail fast at boot on invalid/missing config.

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PERSISTENCE: z.enum(['memory', 'prisma']).default('memory'),
  DATABASE_URL: z.string().url().optional(),
  GOV_API_KEY: z.string().min(1, 'GOV_API_KEY is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SIGNATURE_SKEW_MS: z.coerce.number().int().nonnegative().default(2000),
})

export type Config = z.infer<typeof ConfigSchema>

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  const config = parsed.data
  if (config.PERSISTENCE === 'prisma' && !config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when PERSISTENCE=prisma')
  }
  return config
}
