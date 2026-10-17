import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { buildCapabilityCatalog } from "../../src/services/capabilities"
import * as accountSelection from "../../src/services/routing/select"
import { isVirtualModelName } from "../../src/services/virtual-models"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, MESSAGE, post, settle } from "./harness"

/**
 * Distpatch virtual models end to end (#9): real Hono, real routing, mocked upstreams.
 *
 * The acceptance criteria, each asserted here against the wire or the usage rows:
 *  A. `auto` / `auto-*` never reaches account selection;
 *  B. the passthrough body carries the selected / upstream concrete model;
 *  C. usage keeps requested + selected + upstream identities;
 *  D. real-model discovery is intact, virtual entries are additive.
 */

/** Synthetic scores, for these tests only — nothing here is a measurement of a real model. */
const capabilities = buildCapabilityCatalog({
  schemaVersion: 1,
  revision: "2026-10-17.1",
  profiles: [
    {
      id: "vendor/alpha",
      aliases: ["alpha"],
      hard: { toolUse: true },
      scores: {
        general: 0.9,
        reasoning: 0.9,
        agentic: 0.9,
        tool_use: 0.9,
        review: 0.9,
        coding: 0.9,
        long_context: 0.9,
        speed: 0.1,
      },
    },
    {
      id: "vendor/beta",
      aliases: ["beta"],
      hard: { toolUse: true },
      scores: { general: 0.5, speed: 0.99 },
    },
    { id: "local/box", aliases: ["box"], tags: ["local"], hard: { toolUse: true } },
  ],
})

const ACTIVE = [
  "auto",
  "auto-fast",
  "auto-local",
  "auto-max",
  "auto-plan",
  "auto-research",
  "auto-review",
  "auto-task",
]

const anthropicAccount = (
  id: string,
  models: readonly string[],
  aliases?: Record<string, string>,
) =>
  account(id, {
    apiKey: `sk-${id}`,
    cipher: CRYPTOR,
    ...(aliases === undefined ? {} : { modelAliases: aliases }),
    snapshot: { supportedModels: [...models] },
  })

const message = (model: string) => MESSAGE.replace('"claude-opus-5"', JSON.stringify(model))

let restoreSelection: (() => void) | null = null
afterEach(() => {
  restoreSelection?.()
  restoreSelection = null
})

/** Every model name account selection was asked about, in call order. */
function watchAccountSelection(): string[] {
  const seen: string[] = []
  const original = accountSelection.selectAccounts
  const spy = spyOn(accountSelection, "selectAccounts").mockImplementation(
    (snapshot, request, options) => {
      seen.push(request.model)
      return original(snapshot, request, options)
    },
  )
  restoreSelection = () => spy.mockRestore()
  return seen
}

/** The `model` an upstream body named — the one field these tests read off the wire. */
function wireModel(body: string | undefined): unknown {
  const parsed: unknown = JSON.parse(body ?? "{}")
  return parsed !== null && typeof parsed === "object" && "model" in parsed
    ? parsed.model
    : undefined
}

describe("A: a virtual name never reaches account selection", () => {
  test.each(ACTIVE)("%s reaches selectAccounts only as its selected concrete model", async (id) => {
    const seen = watchAccountSelection()
    const { app, upstream } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha", "beta", "box"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    const res = await app.request("/v1/messages", post(message(id), bearer()))
    await res.text()

    expect(res.status).toBe(200)
    expect(seen.length).toBeGreaterThan(0)
    for (const model of seen) expect(isVirtualModelName(model)).toBe(false)
    expect(upstream.calls[0]?.body).not.toContain('"auto')
  })

  test("a fixed request reaches selectAccounts with exactly the name it sent", async () => {
    const seen = watchAccountSelection()
    const { app } = harness({
      accounts: [anthropicAccount("acct-1", ["some-uncatalogued-model"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    const res = await app.request(
      "/v1/messages",
      post(message("some-uncatalogued-model"), bearer()),
    )

    expect(res.status).toBe(200)
    expect(seen).toEqual(["some-uncatalogued-model"])
  })

  test.each(["auto-does-not-exist", "auto-moe", "auto-free"])(
    "%s is a 404 and account selection is never asked",
    async (id) => {
      const seen = watchAccountSelection()
      const { app, upstream, usage } = harness({
        // A passthrough account that would happily serve any name, were the name ever routed.
        accounts: [account("open", { apiKey: "sk-open", cipher: CRYPTOR })],
        responses: [() => jsonResponse(200, {})],
        capabilities,
      })

      const res = await app.request("/v1/messages", post(message(id), bearer()))
      await settle()

      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } })
      expect(seen).toEqual([])
      expect(upstream.calls).toHaveLength(0)
      expect(usage.rows).toHaveLength(1)
      expect(usage.rows[0]).toMatchObject({
        model: id,
        selectedModel: null,
        upstreamModel: null,
        accountId: null,
        outcome: "client_error",
      })
    },
  )

  test("a router built without a capability catalog refuses every reserved name", async () => {
    const seen = watchAccountSelection()
    const { app, upstream } = harness({
      accounts: [account("open", { apiKey: "sk-open", cipher: CRYPTOR })],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(message("auto"), bearer()))

    expect(res.status).toBe(404)
    expect(seen).toEqual([])
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("no eligible concrete model", () => {
  const noLocal = () =>
    harness({
      accounts: [anthropicAccount("acct-1", ["alpha"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

  test("is a 422 in the Anthropic shape, and account selection is never asked", async () => {
    const seen = watchAccountSelection()
    const { app, upstream, usage } = noLocal()

    const res = await app.request("/v1/messages", post(message("auto-local"), bearer()))
    await settle()
    const body = (await res.json()) as { type: string; error: { type: string; message: string } }

    expect(res.status).toBe(422)
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
    expect(body.error.message).toContain('virtual model "auto-local"')
    expect(body.error.message).toContain("policy auto-local v1")
    expect(body.error.message).not.toContain("sk-acct-1")
    expect(seen).toEqual([])
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows[0]).toMatchObject({
      model: "auto-local",
      selectedModel: null,
      outcome: "no_healthy_account",
      errorClass: "NoEligibleModelError",
    })
  })

  test("is a 422 in the OpenAI shape, with its own stable code", async () => {
    const { app } = noLocal()
    const body = JSON.stringify({ model: "auto-local", messages: [] })

    const res = await app.request("/v1/chat/completions", post(body, bearer()))

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "no_eligible_model" },
    })
  })
})

describe("embeddings", () => {
  test("a virtual model is refused, and a fixed embedding model is untouched", async () => {
    const { app, upstream } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      responses: [() => jsonResponse(200, { data: [] })],
      capabilities,
    })

    const virtual = await app.request(
      "/v1/embeddings",
      post(JSON.stringify({ model: "auto", input: "x" }), bearer()),
    )
    expect(virtual.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)

    const fixed = JSON.stringify({ model: "text-embedding-3-small", input: "x" })
    const res = await app.request("/v1/embeddings", post(fixed, bearer()))
    expect(res.status).toBe(200)
    expect(upstream.calls[0]?.body).toBe(fixed)
  })
})

describe("B: the bytes on the wire", () => {
  test("fixed, no alias: byte-identical", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount("acct-1", ["claude-opus-5", "alpha"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls[0]?.body).toBe(MESSAGE)
  })

  test("fixed, aliased: only the alias rewrite, exactly as before", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount("acct-1", ["glm-4.7"], { "claude-opus-5": "glm-4.7" })],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls[0]?.body).toBe(MESSAGE.replace("claude-opus-5", "glm-4.7"))
  })

  test("virtual, no alias: `auto-task` is rewritten to the selected model, nothing else moves", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha", "beta"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await app.request("/v1/messages", post(message("auto-task"), bearer()))

    // Selected and upstream agree here, yet the bytes still had to change: they said `auto-task`.
    expect(upstream.calls[0]?.body).toBe(message("alpha"))
  })

  test("virtual, aliased: the account's upstream name, not the virtual or the selected one", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha-wire"], { alpha: "alpha-wire" })],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await app.request("/v1/messages", post(message("auto-task"), bearer()))

    expect(upstream.calls[0]?.body).toBe(message("alpha-wire"))
  })

  test("translated: the converted body names the concrete model, never `auto-*`", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("oa", {
          provider: "openai-api",
          apiKey: "sk-o",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["alpha"] },
        }),
      ],
      responses: [() => jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 2 } })],
      capabilities,
    })

    const res = await app.request("/v1/messages", post(message("auto-research"), bearer()))
    const answered: unknown = await res.json()

    expect(res.status).toBe(200)
    expect(wireModel(upstream.calls[0]?.body)).toBe("alpha")
    expect(upstream.calls[0]?.body).not.toContain("auto")
    // The upstream named no model of its own, so the translated answer falls back to the concrete one.
    expect(answered).toMatchObject({ model: "alpha" })
  })

  test("translated across accounts with different aliases: each gets its own wire name", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("oa", {
          provider: "openai-api",
          apiKey: "sk-o",
          cipher: CRYPTOR,
          modelAliases: { alpha: "alpha-openai" },
          snapshot: { supportedModels: ["alpha-openai"] },
        }),
        account("ob", {
          provider: "openai-api",
          apiKey: "sk-ob",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["alpha"] },
        }),
      ],
      responses: [() => jsonResponse(429, {}), () => jsonResponse(200, {})],
      capabilities,
    })

    const res = await app.request("/v1/messages", post(message("auto"), bearer()))
    await res.text()

    const sent = upstream.calls.map((call) => wireModel(call.body))
    expect(sent.sort()).toEqual(["alpha", "alpha-openai"])
    for (const call of upstream.calls) expect(call.body).not.toContain("auto")
  })
})

describe("C: three model identities on every usage row", () => {
  test("virtual: requested, selected and upstream each recorded", async () => {
    const { app, usage } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha", "beta"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await (await app.request("/v1/messages", post(message("auto-fast"), bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      model: "auto-fast",
      selectedModel: "beta",
      upstreamModel: "beta",
      outcome: "success",
    })
  })

  test("virtual with an account alias: all three differ", async () => {
    const { app, usage } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha-wire"], { alpha: "alpha-wire" })],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await (await app.request("/v1/messages", post(message("auto"), bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({
      model: "auto",
      selectedModel: "alpha",
      upstreamModel: "alpha-wire",
    })
  })

  test("fixed: selected is null — no semantic selection happened", async () => {
    const { app, usage } = harness({
      accounts: [anthropicAccount("acct-1", ["glm-4.7"], { "claude-opus-5": "glm-4.7" })],
      responses: [() => jsonResponse(200, {})],
      capabilities,
    })

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({
      model: "claude-opus-5",
      selectedModel: null,
      upstreamModel: "glm-4.7",
    })
  })

  test("failover: every attempt tells the same semantic story; only the wire name varies", async () => {
    const { app, usage, upstream } = harness({
      accounts: [
        account("a", {
          apiKey: "sk-a",
          cipher: CRYPTOR,
          modelAliases: { alpha: "alpha-on-a" },
          snapshot: { supportedModels: ["alpha-on-a"], priority: 0 },
        }),
        account("b", {
          apiKey: "sk-b",
          cipher: CRYPTOR,
          modelAliases: { alpha: "alpha-on-b" },
          snapshot: { supportedModels: ["alpha-on-b"], priority: 1 },
        }),
      ],
      selection: { unpooledPolicy: "priority-failover" },
      responses: [() => jsonResponse(503, { error: {} }), () => jsonResponse(200, {})],
      capabilities,
    })

    const res = await app.request("/v1/messages", post(message("auto-review"), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls.map((call) => call.body)).toEqual([
      message("alpha-on-a"),
      message("alpha-on-b"),
    ])
    expect(usage.rows).toHaveLength(2)
    expect(new Set(usage.rows.map((row) => row.correlationId)).size).toBe(1)
    expect(usage.rows.map((row) => [row.model, row.selectedModel, row.upstreamModel])).toEqual([
      ["auto-review", "alpha", "alpha-on-a"],
      ["auto-review", "alpha", "alpha-on-b"],
    ])
  })
})

describe("the decision trace", () => {
  test("one structured line names the policy, catalog revision and digests — no prompt", async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: "info",
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    const { app } = harness({
      accounts: [anthropicAccount("acct-1", ["alpha"])],
      responses: [() => jsonResponse(200, {})],
      capabilities,
      logger,
    })

    await (await app.request("/v1/messages", post(message("auto-plan"), bearer()))).text()

    const trace = lines.filter((line) => line.msg === "virtual model selected")
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      component: "model-selection",
      requestedModel: "auto-plan",
      selectedModel: "alpha",
      selectedProfile: "vendor/alpha",
      policyId: "auto-plan",
      policyVersion: 1,
      catalogRevision: capabilities.revision().effective,
      selectorVersion: 1,
    })
    expect(trace[0]?.policyDigest).toMatch(/^sha256:/)
    expect(trace[0]?.decisionDigest).toMatch(/^sha256:/)
    expect(JSON.stringify(trace)).not.toContain("hello")
    expect(JSON.stringify(trace)).not.toContain("sk-acct-1")
  })
})

describe("D: discovery", () => {
  type OpenAiList = { data: Record<string, unknown>[] }
  type AnthropicList = { data: Record<string, unknown>[] }

  const pool = () => [anthropicAccount("acct-1", ["alpha", "beta"])]

  test("OpenAI shape: the real entries exactly as without virtual models, then router-owned ones", async () => {
    const plain = harness({ accounts: pool(), responses: [] })
    const virtual = harness({ accounts: pool(), responses: [], capabilities })

    const before = (await (
      await plain.app.request("/v1/models", { headers: bearer() })
    ).json()) as OpenAiList
    const after = (await (
      await virtual.app.request("/v1/models", { headers: bearer() })
    ).json()) as OpenAiList

    expect(after.data.slice(0, before.data.length)).toEqual(before.data)
    const added = after.data.slice(before.data.length)
    // No local profile in scope, so `auto-local` is not offered to this key.
    expect(added.map((entry) => entry.id)).toEqual(ACTIVE.filter((id) => id !== "auto-local"))
    for (const entry of added) {
      expect(entry.owned_by).toBe("distpatch")
      expect(entry).not.toHaveProperty("resolved_model")
      expect(entry).not.toHaveProperty("context_length")
      expect(entry).not.toHaveProperty("max_completion_tokens")
    }
  })

  test("Anthropic shape: virtual entries carry null sizes rather than invented ones", async () => {
    const { app } = harness({ accounts: pool(), responses: [], capabilities })

    const res = await app.request("/v1/models", { headers: { "x-api-key": KEY } })
    const body = (await res.json()) as AnthropicList & { last_id: string }

    expect(body.data.find((entry) => entry.id === "auto")).toEqual({
      type: "model",
      id: "auto",
      display_name: "auto",
      max_input_tokens: null,
      max_tokens: null,
    })
    expect(body.last_id).toBe("auto-task")
  })

  test("a key whose scope holds no candidate is offered no virtual model", async () => {
    const { app } = harness({
      accounts: pool(),
      responses: [],
      capabilities,
      scope: "accounts",
      accountIds: [],
    })

    const listed = (await (
      await app.request("/v1/models", { headers: bearer() })
    ).json()) as OpenAiList

    expect(listed.data).toEqual([])
  })

  test("a cooldown does not make virtual models blink out of the listing", async () => {
    const { app, health } = harness({ accounts: pool(), responses: [], capabilities })
    for (let index = 0; index < 10; index += 1) {
      health.recordFailure("acct-1", { kind: "server-error", message: "500" }, new Date())
    }

    const listed = (await (
      await app.request("/v1/models", { headers: bearer() })
    ).json()) as OpenAiList

    expect(listed.data.map((entry) => entry.id)).toContain("auto-task")
  })

  test("GET /v1/models/:id answers an active virtual id as router-owned", async () => {
    const seen = watchAccountSelection()
    const { app } = harness({ accounts: pool(), responses: [], capabilities })

    const res = await app.request("/v1/models/auto-research", { headers: bearer() })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "auto-research", owned_by: "distpatch" })
    expect(seen).toEqual([])
  })

  test.each(["auto-moe", "auto-does-not-exist", "auto-local"])(
    "GET /v1/models/%s is a 404 and never probes account selection",
    async (id) => {
      const seen = watchAccountSelection()
      const { app } = harness({ accounts: pool(), responses: [], capabilities })

      const res = await app.request(`/v1/models/${id}`, { headers: { "x-api-key": KEY } })

      // The same answer the concrete probe gives an unreachable id (`/v1/models` speaks no dialect).
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: { code: "model_not_found" } })
      expect(seen).toEqual([])
    },
  )

  test("GET /v1/models/:id for a concrete id is unchanged", async () => {
    const { app } = harness({ accounts: pool(), responses: [], capabilities })

    const res = await app.request("/v1/models/alpha", { headers: bearer() })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "alpha", owned_by: "anthropic-api" })
  })
})
