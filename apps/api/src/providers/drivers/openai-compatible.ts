import { createHttpDriver } from "../driver"
import { parseCompatibleRateLimit } from "../rate-limit/compatible-body"
import { genericCreditsRule, reportedQuotaResetRule } from "./compatible-rules"

/**
 * `openai-compatible` — the escape hatch for any vLLM / Ollama / LiteLLM / vendor endpoint that
 * speaks OpenAI Chat Completions or Responses. Chat remains the default; an Account explicitly
 * selects Responses. No pinned endpoint: the Account's own base URL is the only
 * address it has, and an Account without one cannot be addressed at all.
 */
export const openAiCompatibleDriver = createHttpDriver({
  id: "openai-compatible",
  surfaces: [
    { dialect: "openai-chat", baseUrl: null },
    { dialect: "openai-responses", baseUrl: null },
  ],
  parseRateLimit: parseCompatibleRateLimit,
  rules: [reportedQuotaResetRule, genericCreditsRule],
})
