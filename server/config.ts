import 'dotenv/config'

export interface Config {
  port: number
  appBaseUrl: string
  allowedOrigins: string[]
  databasePath: string
  anthropicApiKey: string | null
  anthropicModel: string
  resendApiKey: string | null
  emailFrom: string
  demoExpertEmail: string | null
  passwords: { consultant: string | null; expert: string | null; nlExpert: string | null }
  limits: { maxUploadBytes: number; maxTextChars: number; llmTimeoutMs: number }
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appBaseUrl = blank(env.APP_BASE_URL) ?? `http://localhost:${env.PORT ?? 8787}`
  return {
    port: Number(env.PORT ?? 8787),
    appBaseUrl,
    allowedOrigins: [new URL(appBaseUrl).origin, 'http://localhost:5173'],
    databasePath: blank(env.DATABASE_PATH) ?? './data/vouch.sqlite',
    anthropicApiKey: blank(env.ANTHROPIC_API_KEY),
    anthropicModel: blank(env.ANTHROPIC_MODEL) ?? 'claude-opus-5',
    resendApiKey: blank(env.RESEND_API_KEY),
    emailFrom: blank(env.EMAIL_FROM) ?? 'Vouch demo <onboarding@resend.dev>',
    demoExpertEmail: blank(env.DEMO_EXPERT_EMAIL),
    passwords: {
      consultant: blank(env.DEMO_CONSULTANT_PASSWORD),
      expert: blank(env.DEMO_EXPERT_PASSWORD),
      nlExpert: blank(env.DEMO_NL_EXPERT_PASSWORD),
    },
    limits: { maxUploadBytes: 1_000_000, maxTextChars: 30_000, llmTimeoutMs: 60_000 },
  }
}
