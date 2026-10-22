import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCase, ToolTranscript } from "./cases"
import { CalibrationSandboxUnavailableError } from "./sandbox"

/**
 * How the calibration harness reaches a model. A route is *evaluation plumbing only*: it never
 * enters the router's request path, and its identity is recorded next to — never inside — the
 * model's scores. Endpoints and credentials come from the environment; neither is written to a
 * result file (only the route name is).
 */

export interface TextReply {
  readonly answer: string
  readonly latencyMs: number
}

export interface SpeedSample {
  /** Request start → first streamed content or reasoning delta. */
  readonly ttftMs: number
  readonly wallMs: number
  /** Output tokens as reported by the endpoint's usage block; `null` when it reports none. */
  readonly outputTokens: number | null
}

export interface Route {
  readonly name: string
  /** Transport/runtime description (never a credential or secret URL). */
  readonly runtime: string
  /** Route evaluation settings (temperature, maxTokens, tool delivery). */
  readonly settings: Record<string, unknown>
  /** `false` when the transport cannot pass caller-defined tools (tool_use/agentic unmeasured). */
  readonly tools: boolean
  text(prompt: string): Promise<TextReply>
  runTools?(c: ToolCase): Promise<{ transcript: ToolTranscript; state: unknown; latencyMs: number }>
  speed?(prompt: string): Promise<SpeedSample>
}

const SYSTEM = "You are a helpful assistant. Follow the user's formatting instructions exactly."
const MAX_TOKENS = 16_384
const DEADLINE_MS = 600_000

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}
const MAX_TOOL_ARGUMENT_CHARS = 65_536

function parseToolArguments(value: unknown): {
  readonly args: Record<string, unknown>
  readonly valid: boolean
} {
  if (typeof value !== "string" || value.length > MAX_TOOL_ARGUMENT_CHARS)
    return { args: {}, valid: false }
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { args: {}, valid: false }
    return { args: parsed as Record<string, unknown>, valid: true }
  } catch {
    return { args: {}, valid: false }
  }
}

/** OpenAI Chat Completions, temperature 0, the model's default reasoning behavior. */
export function openAiChatRoute(name: string, baseUrl: string, model: string, key?: string): Route {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (key) headers.authorization = `Bearer ${key}`
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, temperature: 0, max_tokens: MAX_TOKENS, ...body }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    })
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
    return res
  }
  const complete = async (messages: ChatMessage[], tools?: ToolCase["tools"]) => {
    const res = await post({
      messages,
      ...(tools
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    })
    const json = (await res.json()) as { choices: { message: ChatMessage }[] }
    const message = json.choices[0]?.message
    if (message === undefined) throw new Error(`${name}: empty choices`)
    return message
  }

  return {
    name,
    runtime: "openai-chat",
    settings: { temperature: 0, maxTokens: MAX_TOKENS },
    tools: true,
    async text(prompt) {
      const started = performance.now()
      const message = await complete([
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ])
      return { answer: message.content ?? "", latencyMs: performance.now() - started }
    },
    async runTools(c) {
      const env = c.environment()
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: c.prompt },
      ]
      const calls: { name: string; args: Record<string, unknown> }[] = []
      const started = performance.now()
      let final = ""
      let turns = 0
      while (turns < c.maxTurns) {
        turns++
        const message = await complete(messages, c.tools)
        messages.push({
          role: "assistant",
          content: typeof message.content === "string" ? message.content : "",
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
        })
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        if (toolCalls.length === 0) {
          final = typeof message.content === "string" ? message.content : ""
          break
        }
        for (const call of toolCalls) {
          const name = typeof call?.function?.name === "string" ? call.function.name : ""
          const parsed = parseToolArguments(call?.function?.arguments)
          const args = parsed.args
          let result: string
          if (!parsed.valid) {
            result = "error: arguments are not valid JSON"
          } else {
            try {
              const returned = await env.call(name, args)
              result =
                typeof returned === "string" ? returned : "error: tool returned a non-text result"
            } catch (error) {
              if (error instanceof CalibrationSandboxUnavailableError) throw error
              result = "error: tool call failed"
            }
          }
          calls.push({ name, args })
          messages.push({
            role: "tool",
            tool_call_id: typeof call?.id === "string" ? call.id : "",
            content: result,
          })
        }
      }
      return {
        transcript: { calls, final, turns },
        state: (await env.state?.()) ?? null,
        latencyMs: performance.now() - started,
      }
    },
    async speed(prompt) {
      const started = performance.now()
      const res = await post({
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: prompt }],
      })
      let ttftMs: number | null = null
      let outputTokens: number | null = null
      const decoder = new TextDecoder()
      let buffer = ""
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf("\n")
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf("\n")
          if (!line.startsWith("data:") || line === "data: [DONE]") continue
          const event = JSON.parse(line.slice(5)) as {
            choices?: {
              delta?: { content?: string; reasoning_content?: string; reasoning?: string }
            }[]
            usage?: { completion_tokens?: number }
          }
          const delta = event.choices?.[0]?.delta
          if (ttftMs === null && (delta?.content || delta?.reasoning_content || delta?.reasoning)) {
            ttftMs = performance.now() - started
          }
          if (event.usage?.completion_tokens !== undefined)
            outputTokens = event.usage.completion_tokens
        }
      }
      const wallMs = performance.now() - started
      return { ttftMs: ttftMs ?? wallMs, wallMs, outputTokens }
    },
  }
}

/**
 * The Claude Code CLI in print mode, built-in tools disabled and the system prompt replaced.
 * Caller-defined tools reach it through a per-case MCP stdio server (`mcp-env.ts`) running the same
 * mock environment as the Chat route; the model sees them as `mcp__cal__<name>`. Its wall time
 * includes CLI start-up: recorded, never used as a speed measurement.
 */
export function claudeCliRoute(model: string): Route {
  const invoke = async (prompt: string, extra: readonly string[], cwd: string) => {
    const env: Record<string, string> = {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    }
    for (const name of ["LANG", "LC_ALL", "XDG_CONFIG_HOME"] as const) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--system-prompt",
        SYSTEM,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--permission-prompts",
        "none",
        "--output-format",
        "json",
        ...extra,
      ],
      { stdin: new Blob([prompt]), stdout: "pipe", stderr: "ignore", cwd, env },
    )
    const timer = setTimeout(() => proc.kill(), DEADLINE_MS)
    const out = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    const json = JSON.parse(out) as {
      result?: string
      is_error?: boolean
      subtype?: string
      modelUsage?: object
      num_turns?: number
    }
    // Running out of turns is a graded outcome (the task was not finished), not a transport error.
    if (json.is_error && json.subtype !== "error_max_turns")
      throw new Error(
        `claude-cli: ${json.subtype ?? "error"}: ${String(json.result ?? "").slice(0, 120)}`,
      )
    const served = Object.keys(json.modelUsage ?? {})
    if (!served.includes(model))
      throw new Error(`claude-cli: served ${served.join(",")}, not ${model}`)
    return { answer: json.result ?? "", turns: json.num_turns ?? 0 }
  }
  return {
    name: "claude-cli",
    runtime: "claude-code-cli",
    settings: { temperature: "cli-default", builtInTools: false, mcpTools: true },
    tools: true,
    async text(prompt) {
      const cwd = await mkdtemp(join(tmpdir(), "distpatch-cal-cli-"))
      try {
        const started = performance.now()
        const { answer } = await invoke(prompt, [], cwd)
        return { answer, latencyMs: performance.now() - started }
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    },
    async runTools(c) {
      const dir = await mkdtemp(join(tmpdir(), "distpatch-cal-mcp-"))
      const stateFile = join(dir, "state.json")
      const config = join(dir, "mcp.json")
      const readRecorded = async () => {
        try {
          return (await Bun.file(stateFile).json()) as {
            calls?: ToolTranscript["calls"]
            state?: unknown
            sandboxUnavailable?: unknown
          }
        } catch {
          return null
        }
      }
      try {
        await Bun.write(
          config,
          JSON.stringify({
            mcpServers: {
              cal: {
                command: "bun",
                args: [join(import.meta.dir, "mcp-env.ts")],
                env: { CAL_CASE: c.id, CAL_STATE_FILE: stateFile },
              },
            },
          }),
        )
        const started = performance.now()
        const { answer, turns } = await invoke(
          c.prompt,
          ["--mcp-config", config, "--allowedTools", "mcp__cal", "--max-turns", String(c.maxTurns)],
          dir,
        )
        const recorded = await readRecorded()
        if (typeof recorded?.sandboxUnavailable === "string")
          throw new CalibrationSandboxUnavailableError(recorded.sandboxUnavailable)
        if (recorded === null || !Array.isArray(recorded.calls))
          throw new Error("claude-cli: missing tool transcript")
        return {
          transcript: { calls: recorded.calls, final: answer, turns },
          state: recorded.state,
          latencyMs: performance.now() - started,
        }
      } catch (error) {
        const recorded = await readRecorded()
        if (typeof recorded?.sandboxUnavailable === "string")
          throw new CalibrationSandboxUnavailableError(recorded.sandboxUnavailable)
        throw error
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
