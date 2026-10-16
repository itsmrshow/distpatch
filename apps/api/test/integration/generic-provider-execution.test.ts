import { expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { httpDriver } from "../../src/providers"
import { runAttempt } from "../../src/services/dataplane/attempt"
import { listUpstreamModels } from "../../src/services/models/listing"
import { accountRow } from "../support/account-row"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

const profiles = [
  { name: "dockerlm", provider: "ollama", dialect: "openai-chat" },
  { name: "nvidia", provider: "openai-compatible", dialect: "openai-chat" },
  { name: "zen-chat", provider: "openai-compatible", dialect: "openai-chat" },
  { name: "zen-responses", provider: "openai-compatible", dialect: "openai-responses" },
] as const
const MODEL = "organization/model-free"
const SECRET = "synthetic-private-key-closure"
for (const profile of profiles) {
  const target = () => ({
    ...account(profile.name, {
      provider: profile.provider,
      dialect: profile.dialect,
      baseUrl: "https://stub.test/prefix/v1",
      apiKey: SECRET,
      cipher: CRYPTOR,
    }),
    ...(profile.provider === "ollama" ? { authMaterial: null } : {}),
  })
  const path = profile.dialect === "openai-chat" ? "/v1/chat/completions" : "/v1/responses"
  const body = (stream = false) =>
    JSON.stringify({
      model: MODEL,
      stream,
      ...(profile.dialect === "openai-chat"
        ? {
            messages: [{ role: "user", content: "hi" }],
            response_format: { type: "json_object" },
            tools: [
              { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
            ],
          }
        : { input: "hi", text: { format: { type: "json_object" } } }),
    })

  test(`${profile.name}: ordinary generation preserves body, model and auth`, async () => {
    const answer =
      profile.dialect === "openai-chat"
        ? {
            model: MODEL,
            choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }
        : { model: MODEL, output: [], usage: { input_tokens: 2, output_tokens: 3 } }
    const { app, upstream, usage } = harness({
      accounts: [target()],
      responses: [() => jsonResponse(200, answer)],
    })
    const res = await app.request(path, post(body(), bearer()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(answer)
    expect(upstream.calls[0]?.body).toBe(body())
    expect(upstream.calls[0]?.headers.get("authorization")).toBe(
      profile.provider === "ollama" ? null : `Bearer ${SECRET}`,
    )
    await settle()
    expect(usage.rows[0]).toMatchObject({
      provider: profile.provider,
      upstreamModel: MODEL,
      tokensIn: 2,
      tokensOut: 3,
      outcome: "success",
    })
  })
  if (profile.dialect === "openai-chat")
    test(`${profile.name}: streaming tools stay byte-for-byte and usage is captured`, async () => {
      const wire = `${[
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: "{" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")}data: [DONE]\n\n`
      const { app, upstream, usage } = harness({
        accounts: [target()],
        responses: [() => new Response(wire, { headers: { "content-type": "text/event-stream" } })],
      })
      const res = await app.request(path, post(body(true), bearer()))
      expect(await res.text()).toBe(wire)
      expect(upstream.calls[0]?.body).toBe(body(true))
      await settle()
      expect(usage.rows[0]).toMatchObject({ tokensIn: 2, tokensOut: 3, outcome: "success" })
    })

  test(`${profile.name}: declared free model IDs and aliases are exposed without discovery side effects`, async () => {
    const { app, upstream } = harness({
      accounts: [
        {
          ...target(),
          snapshot: {
            ...target().snapshot,
            supportedModels: [MODEL, "other-free"],
            modelAliases: { friendly: MODEL },
          },
        },
      ],
      responses: [],
    })
    const res = await app.request("/v1/models", { headers: bearer() })
    const listed = (await res.json()) as { data: { id: string }[] }
    expect(listed.data.map((entry) => entry.id)).toContain("friendly")
    expect(listed.data.map((entry) => entry.id)).toContain("other-free")
    expect(upstream.calls).toHaveLength(0)
  })
  for (const [status, kind] of [
    [400, "invalid-request"],
    [401, "auth"],
    [403, "auth"],
    [404, "invalid-request"],
    [402, "credits-exhausted"],
    [429, "rate-limited"],
    [500, "server-error"],
    [503, "server-error"],
  ] as const) {
    test(`${profile.name}: ${status} classified without leaking credential`, async () => {
      const lines: string[] = []
      const { app, upstream, usage } = harness({
        accounts: [target()],
        maxAttempts: 1,
        logger: createLogger({
          level: "debug",
          write: (line) => {
            lines.push(line)
          },
        }),
        responses: [
          () =>
            jsonResponse(
              status,
              { error: { message: `stub failure ${SECRET}` } },
              status === 429 ? { "retry-after": "30" } : {},
            ),
        ],
      })
      const res = await app.request(path, post(body(true), bearer()))
      const text = await res.text()
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(upstream.calls).toHaveLength(1)
      const driver = httpDriver(profile.provider)
      expect(
        driver?.classifyFailure({
          status,
          headers: new Headers(),
          body: { error: { message: "stub failure" } },
        })?.kind,
      ).toBe(kind)
      expect(usage.rows[0]?.outcome).not.toBe("success")
      // A credential-less account has no selected secret to redact. Never supply one in its fixture error.
      if (profile.provider !== "ollama")
        for (const output of [text, ...lines]) expect(output).not.toContain(SECRET)
    })
  }

  test(`${profile.name}: discovery reads /models with correct auth and retains free IDs`, async () => {
    let called = false
    const row = accountRow({
      provider: profile.provider,
      baseUrl: "https://stub.test/prefix/v1",
      dialect: profile.dialect,
      authMaterial: target().authMaterial,
    })
    const result = await listUpstreamModels(
      {
        cipher: CRYPTOR,
        timeoutMs: 1000,
        fetch: async (request) => {
          called = true
          expect(new URL(request.url).pathname).toBe("/prefix/v1/models")
          expect(request.headers.get("authorization")).toBe(
            profile.provider === "ollama" ? null : `Bearer ${SECRET}`,
          )
          return jsonResponse(200, {
            data: [{ id: MODEL }, { id: MODEL }, { id: "other-free", context_length: 4096 }],
          })
        },
      },
      row,
    )
    expect(called).toBe(true)
    expect(result).toMatchObject({ ok: true, entries: [{ id: MODEL }, { id: "other-free" }] })
    const unreadable = await listUpstreamModels(
      { cipher: CRYPTOR, timeoutMs: 1000, fetch: async () => new Response("not JSON") },
      row,
    )
    expect(unreadable).toMatchObject({ ok: false, code: "discovery_unreadable" })
  })
  test(`${profile.name}: broken stream after first bytes never replays`, async () => {
    const stream = slowStream(['data: {"delta":"started"}\n\n'])
    const { app, upstream, usage } = harness({
      accounts: [target()],
      responses: [() => stream.response],
    })
    const res = await app.request(path, post(body(true), bearer()))
    const reader = res.body?.getReader()
    stream.release(0)
    expect((await reader?.read())?.done).toBe(false)
    stream.abort()
    await expect(reader?.read()).rejects.toThrow()
    await settle()
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows[0]?.outcome).toBe("upstream_error")
  })
  test(`${profile.name}: client cancellation before headers is propagated without retry`, async () => {
    const abort = new AbortController()
    const { app, upstream } = harness({
      accounts: [target()],
      responses: [
        () => {
          abort.abort()
          throw new DOMException("cancelled", "AbortError")
        },
      ],
    })
    const res = await app.request(path, { ...post(body(true), bearer()), signal: abort.signal })
    expect(res.status).toBe(499)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.signal.aborted).toBe(true)
  })
  test(`${profile.name}: real HTTP stub deadline and connection refusal are transport failures`, async () => {
    const driver = httpDriver(profile.provider)
    if (driver === null) throw new Error("missing driver")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(100)
        return jsonResponse(200, {})
      },
    })
    const url = new URL("/v1/models", server.url)
    const run = () =>
      runAttempt({
        plan: { account: target(), driver, dialect: profile.dialect, url, upstreamModel: MODEL },
        method: "GET",
        clientHeaders: new Headers(),
        body: null,
        fetch,
        cipher: CRYPTOR,
        timeoutMs: 10,
      })
    try {
      expect(await run()).toMatchObject({ kind: "failure", failure: { kind: "timeout" } })
    } finally {
      await server.stop(true)
    }
    expect(await run()).toMatchObject({ kind: "failure", failure: { kind: "connection" } })
  })
}

test("authenticated generic Responses cannot silently become anonymous", async () => {
  const target = {
    ...account("missing", {
      provider: "openai-compatible",
      dialect: "openai-responses",
      cipher: CRYPTOR,
    }),
    authMaterial: null,
  }
  const { app, upstream } = harness({ accounts: [target], responses: [] })
  const res = await app.request(
    "/v1/responses",
    post(JSON.stringify({ model: MODEL, input: "hi" }), bearer()),
  )
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(upstream.calls).toHaveLength(0)
})
