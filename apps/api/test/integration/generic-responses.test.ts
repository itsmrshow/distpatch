import { expect, test } from "bun:test"
import { describeProvider } from "../../src/services/accounts/providers"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

const MODEL = "vendor/model-free"
const BASE = "https://compatible.test/custom/v1"
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
const format = { type: "json_schema", name: "answer", strict: true, schema }
const tool = { type: "function", name: "lookup", parameters: schema }
const output = [
  {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"ok":true}',
  },
]
const responseBody = {
  id: "resp_1",
  object: "response",
  model: MODEL,
  status: "completed",
  output,
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
}
function target(dialect: "openai-chat" | "openai-responses" = "openai-responses") {
  return account(dialect, {
    provider: "openai-compatible",
    dialect,
    baseUrl: BASE,
    cipher: CRYPTOR,
  })
}
function frame(type: string, fields: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}
const events = [
  frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
  frame("response.output_item.added", { output_index: 0, item: { ...output[0], arguments: "" } }),
  frame("response.function_call_arguments.delta", {
    item_id: "fc_1",
    output_index: 0,
    delta: '{"ok":',
  }),
  frame("response.function_call_arguments.delta", {
    item_id: "fc_1",
    output_index: 0,
    delta: "true}",
  }),
  frame("response.output_item.done", { output_index: 0, item: output[0] }),
  frame("response.completed", { response: responseBody }),
].join("")

test("generic account exposes Chat and Responses without changing the Chat default", () => {
  expect(describeProvider("openai-compatible")).toMatchObject({
    nativeDialect: "openai-chat",
    supportedDialects: ["openai-chat", "openai-responses"],
    requiresBaseUrl: true,
    authKind: "api-key",
  })
})

for (const stream of [false, true]) {
  test(`generic Responses same-dialect bytes, tools, schema and usage (stream=${stream})`, async () => {
    const raw = ` { "model": "${MODEL}", "input": "hello", "stream": ${stream}, "tools": ${JSON.stringify([tool])}, "text": ${JSON.stringify({ format })}, "unknown": 123 } `
    const wire = stream ? events : JSON.stringify(responseBody)
    const { app, upstream, usage } = harness({
      accounts: [target()],
      responses: [
        () =>
          new Response(wire, {
            headers: { "content-type": stream ? "text/event-stream" : "application/json" },
          }),
      ],
    })
    const res = await app.request("/v1/responses", post(raw, bearer()))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(wire)
    expect(upstream.calls[0]).toMatchObject({ url: `${BASE}/responses`, body: raw })
    expect(upstream.calls[0]?.headers.get("authorization")).toBe("Bearer sk-openai-responses")
    await settle()
    expect(usage.rows[0]).toMatchObject({
      accountId: "openai-responses",
      outcome: "success",
      egressMode: "passthrough",
      tokensIn: 11,
      tokensOut: 7,
    })
  })

  test(`Chat translates onto generic Responses: schema, tools, model and usage (stream=${stream})`, async () => {
    const { app, upstream, usage } = harness({
      accounts: [target()],
      responses: [
        () =>
          stream
            ? new Response(events, { headers: { "content-type": "text/event-stream" } })
            : jsonResponse(200, responseBody),
      ],
    })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "lookup" }],
          stream,
          max_tokens: 64,
          tools: [{ type: "function", function: { name: "lookup", parameters: schema } }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema },
          },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("lookup")
    expect(text).toContain("call_1")
    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}")
    expect(upstream.calls[0]?.url).toBe(`${BASE}/responses`)
    expect(sent).toMatchObject({
      model: MODEL,
      stream,
      max_output_tokens: 64,
      text: { format },
      tools: [tool],
    })
    // Generic endpoints must not inherit Codex's forced stream or removed ceilings.
    expect(sent.store).toBe(false)
    await settle()
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "translate",
      tokensIn: 11,
      tokensOut: 7,
    })
  })
}

test("two generic accounts select independent surfaces and authoritative URLs", async () => {
  for (const dialect of ["openai-chat", "openai-responses"] as const) {
    const { app, upstream } = harness({
      accounts: [target("openai-chat"), target()],
      scope: "accounts",
      accountIds: [dialect],
      responses: [() => jsonResponse(200, responseBody)],
    })
    const path = dialect === "openai-chat" ? "chat/completions" : "responses"
    const raw = JSON.stringify({
      model: MODEL,
      ...(dialect === "openai-chat"
        ? { messages: [{ role: "user", content: "hi" }] }
        : { input: "hi" }),
    })
    const res = await app.request(`/v1/${path}`, post(raw, bearer()))
    const body = await res.text()
    if (res.status !== 200) throw new Error(body)
    expect(upstream.calls[0]?.url).toBe(`${BASE}/${path}`)
    expect(upstream.calls[0]?.body).toBe(raw)
  }
})

test("Anthropic request translates onto generic Responses and back", async () => {
  const { app, upstream, usage } = harness({
    accounts: [target()],
    responses: [() => jsonResponse(200, responseBody)],
  })
  const res = await app.request(
    "/v1/messages",
    post(
      JSON.stringify({
        model: MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "lookup" }],
        tools: [{ name: "lookup", input_schema: schema }],
      }),
      bearer(),
    ),
  )
  expect(res.status).toBe(200)
  expect((await res.json()).content).toContainEqual({
    type: "tool_use",
    id: "call_1",
    name: "lookup",
    input: { ok: true },
  })
  expect(JSON.parse(upstream.calls[0]?.body ?? "{}")).toMatchObject({
    model: MODEL,
    max_output_tokens: 32,
  })
  await settle()
  expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 11, tokensOut: 7 })
})

test("generic Responses cancellation propagates and never replays after output starts", async () => {
  const abort = new AbortController()
  const stream = slowStream([events])
  const { app, upstream } = harness({ accounts: [target()], responses: [() => stream.response] })
  const res = await app.request("/v1/responses", {
    ...post(JSON.stringify({ model: MODEL, input: "hi", stream: true }), bearer()),
    signal: abort.signal,
  })
  const reader = res.body?.getReader()
  stream.release(0)
  expect((await reader?.read())?.done).toBe(false)
  abort.abort()
  expect(upstream.calls[0]?.signal.aborted).toBe(true)
  stream.abort()
  await reader?.read().catch(() => undefined)
  expect(upstream.calls).toHaveLength(1)
})

test("malformed translated request fails before generic upstream execution", async () => {
  const { app, upstream } = harness({ accounts: [target()], responses: [] })
  const res = await app.request(
    "/v1/chat/completions",
    post(
      JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "invalid" },
      }),
      bearer(),
    ),
  )
  expect(res.status).toBe(400)
  expect(upstream.calls).toHaveLength(0)
})

test("Responses ingress still translates onto a generic Chat account", async () => {
  const { app, upstream, usage } = harness({
    accounts: [target("openai-chat")],
    responses: [
      () =>
        jsonResponse(200, {
          id: "chat_1",
          object: "chat.completion",
          model: MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
    ],
  })
  const res = await app.request(
    "/v1/responses",
    post(JSON.stringify({ model: MODEL, input: "hi", store: false }), bearer()),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({
    object: "response",
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
  })
  expect(upstream.calls[0]?.url).toBe(`${BASE}/chat/completions`)
  expect(JSON.parse(upstream.calls[0]?.body ?? "{}")).toMatchObject({
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
  })
  await settle()
  expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 2, tokensOut: 3 })
})

test("unreadable upstream success retains raw relay and unknown cost behavior", async () => {
  const { app, upstream, usage } = harness({
    accounts: [target()],
    responses: [
      () => new Response("not JSON", { headers: { "content-type": "application/json" } }),
    ],
  })
  const res = await app.request(
    "/v1/chat/completions",
    post(JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }), bearer()),
  )
  expect(await res.text()).toBe("not JSON")
  expect(res.status).toBe(200)
  expect(upstream.calls).toHaveLength(1)
  await settle()
  expect(usage.rows[0]).toMatchObject({
    outcome: "success",
    tokensIn: 0,
    tokensOut: 0,
    costBasis: "unknown",
    costEstimate: null,
  })
})
