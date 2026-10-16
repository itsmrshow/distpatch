import type { Dialect } from "@multi-ai-router/core"
import { z } from "zod"
import { httpDriver } from "../src/providers"
import { createCredentialCipher } from "../src/services/crypto/cipher"
import { type AttemptOutcome, runAttempt } from "../src/services/dataplane/attempt"
import { type RoutableAccount, routingView } from "../src/services/dataplane/types"
import {
  providerAnswer as answer,
  providerListing as listing,
  probeSchema as schema,
} from "./provider-shapes"
import { gradeProviderStream } from "./provider-stream"

// No raw upstream bodies, credentials, headers, or exception messages reach stdout/stderr.
const profiles = {
  dockerlm: {
    provider: "ollama",
    dialect: "openai-chat",
    url: process.env.DOCKERLM_BASE_URL,
    key: undefined,
  },
  nvidia: {
    provider: "openai-compatible",
    dialect: "openai-chat",
    url: "https://integrate.api.nvidia.com/v1",
    key: process.env.NVIDIA_API_KEY,
  },
  "zen-chat": {
    provider: "openai-compatible",
    dialect: "openai-chat",
    url: "https://opencode.ai/zen/v1",
    key: process.env.ZEN_API_KEY,
  },
  "zen-responses": {
    provider: "openai-compatible",
    dialect: "openai-responses",
    url: "https://opencode.ai/zen/v1",
    key: process.env.ZEN_API_KEY,
  },
} as const
const name = process.argv[2]
if (
  !name ||
  !Object.hasOwn(profiles, name) ||
  process.argv[3] !== "--run" ||
  !process.env.PROVIDER_SMOKE_MODEL
) {
  process.stderr.write(
    "Usage: PROVIDER_SMOKE_MODEL=ID [DOCKERLM_BASE_URL=URL|NVIDIA_API_KEY=…|ZEN_API_KEY=…] bin/provider-smoke dockerlm|nvidia|zen-chat|zen-responses --run\n",
  )
  process.exit(64)
}
const profile = profiles[name as keyof typeof profiles]
if (!profile.url || (profile.provider !== "ollama" && !profile.key)) {
  process.stderr.write("Blocked: endpoint or credential environment variable is absent\n")
  process.exit(2)
}
const base = new URL(URL.canParse(profile.url) ? profile.url : "invalid:configuration")
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !["https:", "http:"].includes(base.protocol)
) {
  process.stderr.write("Invalid endpoint configuration\n")
  process.exit(64)
}
const driver = httpDriver(profile.provider)
const model = process.env.PROVIDER_SMOKE_MODEL
const dialect: Dialect = profile.dialect
const cipher = createCredentialCipher({ key: crypto.getRandomValues(new Uint8Array(32)) })
const id = "provider-smoke"
const account: RoutableAccount = {
  id,
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  driver: { id, provider: profile.provider, baseUrl: base.toString(), dialect },
  snapshot: routingView({ id, label: id, provider: profile.provider }),
  authMaterial: profile.key ? cipher.encrypt(profile.key) : null,
  configDir: null,
  billing: "metered",
}
const timeoutMs = 180_000
function call(
  body: object | null,
  signal?: AbortSignal,
  credential = account.authMaterial,
): Promise<AttemptOutcome> {
  if (!driver) throw new Error("missing provider driver")
  const path =
    body === null ? "models" : dialect === "openai-chat" ? "chat/completions" : "responses"
  return runAttempt({
    plan: {
      account: { ...account, authMaterial: credential },
      driver,
      dialect,
      url: new URL(`${base.toString().replace(/\/$/, "")}/${path}`),
      upstreamModel: model,
    },
    method: body === null ? "GET" : "POST",
    clientHeaders: new Headers({ "content-type": "application/json" }),
    body: body === null ? null : new TextEncoder().encode(JSON.stringify(body)),
    fetch,
    cipher,
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
}
let failed = false
let inconclusive = false
function report(leg: string, status: "PASS" | "FAIL" | "INCONCLUSIVE", facts: object = {}) {
  if (status === "FAIL") failed = true
  if (status === "INCONCLUSIVE") inconclusive = true
  process.stdout.write(`${JSON.stringify({ provider: name, model, leg, status, ...facts })}\n`)
}
function failure(leg: string, result: Exclude<AttemptOutcome, { kind: "success" }>) {
  report(
    leg,
    "FAIL",
    result.kind === "failure"
      ? {
          httpStatus: result.upstream?.status ?? null,
          kind: result.classification?.kind ?? result.failure.kind,
          signal: result.classification?.signal ?? null,
        }
      : { kind: result.kind },
  )
}
function request(extra: object = {}) {
  return {
    model,
    ...(dialect === "openai-chat"
      ? {
          messages: [{ role: "user", content: "Reply with only OK." }],
          max_tokens: 512,
          ...(name === "dockerlm"
            ? { temperature: 0, chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }
      : { input: "Reply with only OK.", max_output_tokens: 512, store: false }),
    ...extra,
  }
}
async function run() {
  const models = await call(null)
  if (models.kind !== "success") failure("models", models)
  else {
    const parsed = listing.safeParse(await models.response.json().catch(() => null))
    report(
      "models",
      parsed.success && parsed.data.data.some((entry) => entry.id === model) ? "PASS" : "FAIL",
      parsed.success
        ? {
            count: parsed.data.data.length,
          }
        : {},
    )
  }
  const functionTool = { name: "closure_probe", description: "Record success", parameters: schema }
  for (const leg of ["text", "stream", "tools", "stream-tools", "structured", "cancel"] as const) {
    const tools = leg.includes("tools")
    const streaming = leg === "stream" || leg === "stream-tools" || leg === "cancel"
    const extra = {
      stream: streaming,
      ...(tools
        ? {
            ...(dialect === "openai-chat"
              ? {
                  messages: [
                    {
                      role: "user",
                      content: "Call closure_probe with ok set to true. Do not answer with text.",
                    },
                  ],
                }
              : { input: "Call closure_probe with ok set to true. Do not answer with text." }),
            tools: [
              dialect === "openai-chat"
                ? { type: "function", function: functionTool }
                : { type: "function", ...functionTool },
            ],
            tool_choice:
              dialect === "openai-chat"
                ? { type: "function", function: { name: "closure_probe" } }
                : { type: "function", name: "closure_probe" },
          }
        : {}),
      ...(leg === "structured"
        ? dialect === "openai-chat"
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "answer", strict: true, schema },
              },
            }
          : { text: { format: { type: "json_schema", name: "answer", strict: true, schema } } }
        : {}),
    }
    const abort = new AbortController()
    const result = await call(request(extra), abort.signal)
    if (result.kind !== "success") {
      failure(leg, result)
      continue
    }
    if (streaming) {
      const reader = result.response.body?.getReader()
      if (!reader) {
        report(leg, "FAIL")
        continue
      }
      const decoder = new TextDecoder()
      let text = ""
      let chunks = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          chunks++
          text += decoder.decode(chunk.value, { stream: true })
          if (leg === "cancel") {
            abort.abort()
            await reader.cancel().catch(() => undefined)
            break
          }
        }
        report(
          leg,
          chunks > 0 && (leg === "cancel" ? abort.signal.aborted : gradeProviderStream(text, tools))
            ? "PASS"
            : "FAIL",
          { chunks },
        )
      } catch {
        report(leg, "FAIL")
      }
    } else {
      const parsed = answer.safeParse(await result.response.json().catch(() => null))
      if (!parsed.success) {
        report(leg, "FAIL")
        continue
      }
      const data = parsed.data
      const content =
        data.choices?.[0]?.message.content ??
        data.output
          ?.flatMap((item) => item.content?.map((part) => part.text ?? "") ?? [])
          .join("") ??
        ""
      const toolCalled =
        data.choices?.[0]?.message.tool_calls?.some(
          (item) => item.function.name === "closure_probe",
        ) ||
        data.output?.some((item) => item.type === "function_call" && item.name === "closure_probe")
      let valid = content.trim().length > 0
      if (tools) valid = toolCalled === true
      if (leg === "structured") {
        try {
          valid = z.object({ ok: z.boolean() }).safeParse(JSON.parse(content)).success
        } catch {
          valid = false
        }
      }
      report(leg, valid ? "PASS" : "FAIL")
    }
  }
  const invalid = await call({ ...request(), model: "distpatch-nonexistent-model-probe" })
  if (invalid.kind === "failure")
    report(
      "invalid-model",
      invalid.classification?.kind === "invalid-request" ? "PASS" : "INCONCLUSIVE",
      {
        httpStatus: invalid.upstream?.status ?? null,
        kind: invalid.classification?.kind ?? invalid.failure.kind,
      },
    )
  else {
    if (invalid.kind === "success") await invalid.response.body?.cancel()
    report("invalid-model", "FAIL")
  }
  if (profile.provider !== "ollama") {
    const badAuth = await call(request(), undefined, cipher.encrypt("distpatch-invalid-key-probe"))
    if (badAuth.kind === "failure")
      report("invalid-auth", badAuth.classification?.kind === "auth" ? "PASS" : "INCONCLUSIVE", {
        httpStatus: badAuth.upstream?.status ?? null,
        kind: badAuth.classification?.kind ?? badAuth.failure.kind,
      })
    else {
      if (badAuth.kind === "success") await badAuth.response.body?.cancel()
      report("invalid-auth", "FAIL")
    }
  }
}
try {
  await run()
} catch {
  report("runtime", "FAIL")
}
process.exitCode = failed ? 1 : inconclusive ? 2 : 0
