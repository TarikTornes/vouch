// Validates ANTHROPIC_MODEL with a small real request. Usage: npm run check:llm
import Anthropic from '@anthropic-ai/sdk'
import { loadConfig } from '../config'

const config = loadConfig()
if (!config.anthropicApiKey) {
  console.error('FAIL: ANTHROPIC_API_KEY is not set in .env')
  process.exit(1)
}
const client = new Anthropic({ apiKey: config.anthropicApiKey })
try {
  const info = await client.models.retrieve(config.anthropicModel)
  console.log(`Model found: ${info.id} (${info.display_name})`)
  const r = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  })
  const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  console.log(`PASS: real request succeeded (stop_reason=${r.stop_reason}, reply=${JSON.stringify(text.trim())}, input_tokens=${r.usage.input_tokens})`)
} catch (e) {
  if (e instanceof Anthropic.APIError) console.error(`FAIL: ${e.status} ${e.message}`)
  else console.error('FAIL:', (e as Error).message)
  process.exit(1)
}
