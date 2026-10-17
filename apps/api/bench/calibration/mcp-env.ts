import { writeFileSync } from "node:fs"
import { CASES } from "./cases"

/**
 * A minimal MCP stdio server exposing one calibration case's mock tools, so a route that cannot
 * pass caller-defined tools in its request (the Claude Code CLI) can still be graded on the same
 * tool_use / agentic cases, against the same environment code.
 *
 * `CAL_CASE` names the case; after every call the transcript and end state are written to
 * `CAL_STATE_FILE` for the harness to grade. Newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */

const c = CASES.find((x) => x.id === process.env.CAL_CASE)
const stateFile = process.env.CAL_STATE_FILE
if (c?.kind !== "tools" || !stateFile) throw new Error("CAL_CASE / CAL_STATE_FILE missing")
const env = c.environment()
const calls: { name: string; args: Record<string, unknown> }[] = []

async function persist() {
  writeFileSync(
    stateFile as string,
    JSON.stringify({ calls, state: (await env.state?.()) ?? null }),
  )
}

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

async function handle(message: {
  id?: unknown
  method?: string
  params?: Record<string, unknown>
}) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: (message.params?.protocolVersion as string) ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "cal", version: "1" },
    })
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools:
        c?.kind === "tools"
          ? c.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            }))
          : [],
    })
  } else if (message.method === "tools/call") {
    const name = String(message.params?.name)
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>
    calls.push({ name, args })
    const text = await env.call(name, args)
    await persist()
    reply(message.id, { content: [{ type: "text", text }] })
  } else if (message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`,
    )
  }
}

await persist()
let buffer = ""
for await (const chunk of process.stdin) {
  buffer += chunk.toString()
  let nl = buffer.indexOf("\n")
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    nl = buffer.indexOf("\n")
    if (line) await handle(JSON.parse(line))
  }
}
