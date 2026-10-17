import { describe, expect, test } from "bun:test"
import type { ModelDescriptor } from "@multi-ai-router/core"
import {
  InvalidRequestError,
  ModelNotFoundError,
  NoEligibleModelError,
} from "@multi-ai-router/core"
import { buildCapabilityCatalog } from "../../../src/services/capabilities"
import {
  chooseModel,
  type RoutingCatalog,
  scopedConcreteModels,
  type VirtualModelRouting,
  virtualModelProbe,
  withVirtualModels,
} from "../../../src/services/dataplane"
import type { KeyScopeSnapshot, PoolSnapshot } from "../../../src/services/routing"
import { account, catalog, subscriptionAccount } from "./fixtures"

/**
 * The step between `admitRoutingModel()` and `selectAccounts()`: fixed names pass untouched, virtual
 * names resolve against the injected capability catalog over the key's **static** candidate set,
 * and every other reserved name is refused before account selection could see it.
 */

/** Synthetic scores, for these tests only. */
const capabilities = buildCapabilityCatalog({
  schemaVersion: 1,
  revision: "2026-10-17.1",
  profiles: [
    {
      id: "vendor/deep",
      aliases: ["deep"],
      hard: { toolUse: true },
      scores: { general: 0.9, reasoning: 0.9, agentic: 0.8, tool_use: 0.8 },
    },
    {
      id: "vendor/plain",
      hard: { toolUse: true },
      scores: { general: 0.5, reasoning: 0.5, agentic: 0.5, tool_use: 0.5 },
    },
    {
      id: "local/box",
      tags: ["local"],
      hard: { toolUse: true },
      scores: { general: 0.3 },
    },
    { id: "vendor/cooling" },
    { id: "vendor/exhausted" },
    { id: "vendor/reauth" },
    { id: "vendor/sonnet-nine", aliases: ["claude-sonnet-9"] },
    // Known non-text profiles, deliberately out-scoring every text model above.
    { id: "vendor/no-text-in", hard: { textInput: false }, scores: { general: 1, reasoning: 1 } },
    { id: "vendor/no-text-out", hard: { textOutput: false }, scores: { general: 1, reasoning: 1 } },
    {
      id: "vendor/no-text",
      hard: { textInput: false, textOutput: false },
      scores: { general: 1, reasoning: 1 },
    },
    {
      id: "vendor/text-yes",
      hard: { textInput: true, textOutput: true },
      scores: { general: 0.4 },
    },
  ],
})

const routing: VirtualModelRouting = { capabilities }
const ALL: KeyScopeSnapshot = { kind: "all" }

const serving = (id: string, models: readonly string[], status?: "disabled" | "cooling_down") =>
  account(id, {
    snapshot: { supportedModels: [...models], ...(status === undefined ? {} : { status }) },
  })

describe("chooseModel", () => {
  test("a fixed name is returned untouched without touching the catalog or the capabilities", () => {
    const untouchable = {
      accounts: () => {
        throw new Error("a fixed request must not enumerate candidates")
      },
      pools: () => {
        throw new Error("a fixed request must not enumerate candidates")
      },
    }
    const strict: VirtualModelRouting = {
      capabilities: {
        resolve: () => {
          throw new Error("a fixed request must not read the capability catalog")
        },
        get: () => null,
        list: () => [],
        revision: () => capabilities.revision(),
      },
    }
    // Uncatalogued on purpose: a fixed request never needs a capability profile.
    expect(chooseModel(strict, untouchable, ALL, "some-uncatalogued-model", "messages")).toEqual({
      requestedModel: "some-uncatalogued-model",
      selectedModel: null,
      virtual: null,
    })
  })

  test("a virtual name resolves to the best concrete candidate in scope", () => {
    const choice = chooseModel(
      routing,
      catalog([serving("a", ["vendor/plain", "deep"])]),
      ALL,
      "auto",
      "messages",
    )
    expect(choice.requestedModel).toBe("auto")
    // The candidate name as the account serves it — the catalog alias, not the canonical id.
    expect(choice.selectedModel).toBe("deep")
    expect(choice.virtual?.descriptor.id).toBe("auto")
    expect(choice.virtual?.decision.selected?.profileId).toBe("vendor/deep")
  })

  test("count_tokens resolves like inference: the concrete model flows through the planner", () => {
    const choice = chooseModel(
      routing,
      catalog([serving("a", ["deep"])]),
      ALL,
      "auto",
      "count-tokens",
    )
    expect(choice.selectedModel).toBe("deep")
  })

  test.each(["auto-does-not-exist", "auto-moe", "auto-free", "AUTO", "auto[1m]"])(
    "%s is not found, before any candidate is read",
    (name) => {
      const accounts = () => {
        throw new Error("an unknown virtual name must not enumerate candidates")
      }
      expect(() =>
        chooseModel(routing, { accounts, pools: () => [] }, ALL, name, "messages"),
      ).toThrow(ModelNotFoundError)
    },
  )

  test("without a capability catalog no virtual model is active, and none leaks through", () => {
    expect(() =>
      chooseModel(undefined, catalog([serving("a", ["deep"])]), ALL, "auto", "messages"),
    ).toThrow(ModelNotFoundError)
  })

  test("a virtual model is refused for embeddings rather than judged by a chat policy", () => {
    expect(() =>
      chooseModel(routing, catalog([serving("a", ["deep"])]), ALL, "auto", "embeddings"),
    ).toThrow(InvalidRequestError)
  })

  test("no eligible candidate is a 422 naming the policy and the reasons, never a model list", () => {
    const run = () =>
      chooseModel(
        routing,
        catalog([serving("a", ["deep", "uncatalogued"])]),
        ALL,
        "auto-local",
        "messages",
      )
    expect(run).toThrow(NoEligibleModelError)
    try {
      run()
    } catch (error) {
      expect(error).toMatchObject({ status: 422, code: "no_eligible_model" })
      const message = (error as Error).message
      expect(message).toContain('"auto-local"')
      expect(message).toContain("policy auto-local v1")
      expect(message).toContain(capabilities.revision().effective)
      expect(message).toContain("1 candidate(s): tag-missing ×1")
      expect(message).not.toContain("deep")
      expect(message).not.toContain("sk-")
    }
  })

  test("nothing in scope is also a 422, not a fall-through to account selection", () => {
    expect(() => chooseModel(routing, catalog([]), ALL, "auto", "messages")).toThrow(
      NoEligibleModelError,
    )
  })
})

describe("scopedConcreteModels", () => {
  const names = (store: RoutingCatalog, scope: KeyScopeSnapshot = ALL) =>
    scopedConcreteModels(store, scope, capabilities)

  test("is the configured, catalogued, requested-side names in scope — sorted and unique", () => {
    const store = catalog([
      serving("a", ["vendor/plain", "deep", "uncatalogued"]),
      serving("b", ["deep"]),
    ])
    // An uncatalogued name could only ever be rejected as `no-profile`, so it is not enumerated.
    expect(names(store)).toEqual(["deep", "vendor/plain"])
  })

  test("an account alias is a candidate only under the name a client sends — never its target", () => {
    const store = catalog([account("c", { modelAliases: { friendly: "vendor/deep" } })])
    // `friendly` has no capability profile of its own; it is not matched through to its target.
    expect(names(store)).toEqual([])
    expect(() => chooseModel(routing, store, ALL, "auto", "messages")).toThrow(NoEligibleModelError)
  })

  test("a catalog alias an account serves resolves to its profile under the served name", () => {
    const choice = chooseModel(routing, catalog([serving("a", ["deep"])]), ALL, "auto", "messages")
    expect(choice.selectedModel).toBe("deep")
    expect(choice.virtual?.decision.selected?.profileId).toBe("vendor/deep")
  })

  test("the candidate keeps the account's own spelling: catalog lookup folds case, the wire does not", () => {
    const choice = chooseModel(routing, catalog([serving("a", ["Deep"])]), ALL, "auto", "messages")
    expect(choice.selectedModel).toBe("Deep")
  })

  test("ignores live state: cooling, exhausted and needs-reauth accounts stay candidates", () => {
    const accounts = [
      account("s1", { snapshot: { supportedModels: ["vendor/cooling"], status: "cooling_down" } }),
      account("s2", { snapshot: { supportedModels: ["vendor/exhausted"], status: "exhausted" } }),
      account("s3", { snapshot: { supportedModels: ["vendor/reauth"], status: "needs_reauth" } }),
    ]
    expect(names(catalog(accounts))).toEqual([
      "vendor/cooling",
      "vendor/exhausted",
      "vendor/reauth",
    ])
  })

  test("an operator-disabled account contributes nothing", () => {
    expect(
      names(catalog([serving("a", ["deep"], "disabled"), serving("b", ["vendor/plain"])])),
    ).toEqual(["vendor/plain"])
  })

  test("the key's scope is an intersection: out-of-scope accounts contribute nothing", () => {
    const accounts = [serving("in", ["deep"]), serving("out", ["vendor/plain"])]
    const team: PoolSnapshot = {
      id: "team",
      name: "team",
      policy: "sticky",
      members: [{ accountId: "in" }],
    }
    expect(names(catalog(accounts), { kind: "accounts", accountIds: ["out"] })).toEqual([
      "vendor/plain",
    ])
    expect(names(catalog(accounts, [team]), { kind: "pools", poolIds: ["team"] })).toEqual(["deep"])
    expect(names(catalog(accounts), { kind: "accounts", accountIds: [] })).toEqual([])
  })

  test("a passthrough account declaring nothing offers no candidate to rank", () => {
    expect(names(catalog([account("open")]))).toEqual([])
  })

  test("reserved names are never candidates, even when an account lists one", () => {
    expect(names(catalog([serving("a", ["auto", "auto-x", "deep"])]))).toEqual(["deep"])
  })

  test("a subscription's discovered catalog rows are candidates", () => {
    const rows: ModelDescriptor[] = [
      {
        id: "claude-sonnet-9",
        resolvedModel: null,
        contextTokens: null,
        maxOutputTokens: null,
        contextSource: null,
        listingSource: "live",
      },
    ]
    const found = scopedConcreteModels(catalog([subscriptionAccount("sub")]), ALL, capabilities, {
      modelsOf: () => rows,
    })
    expect(found).toEqual(["claude-sonnet-9"])
  })
})

describe("known non-text models are never virtual candidates", () => {
  const NON_TEXT = ["vendor/no-text", "vendor/no-text-in", "vendor/no-text-out"]
  const names = (models: readonly string[]) =>
    scopedConcreteModels(catalog([serving("a", models)]), ALL, capabilities)

  test.each(NON_TEXT)("%s is excluded", (model) => {
    expect(names([model, "vendor/plain"])).toEqual(["vendor/plain"])
  })

  test("unknown (null) and known (true) text support both stay candidates", () => {
    // `vendor/plain` declares neither text fact: null is unknown, never read as false.
    expect(capabilities.resolve("vendor/plain")?.hard).toMatchObject({
      textInput: null,
      textOutput: null,
    })
    expect(names(["vendor/plain", "vendor/text-yes"])).toEqual(["vendor/plain", "vendor/text-yes"])
  })

  test("a higher-scored non-text model never enters selection; the text model wins", () => {
    const choice = chooseModel(
      routing,
      catalog([serving("a", [...NON_TEXT, "vendor/plain"])]),
      ALL,
      "auto",
      "messages",
    )
    expect(choice.selectedModel).toBe("vendor/plain")
    expect(choice.virtual?.decision.ranked.map((r) => r.model)).toEqual(["vendor/plain"])
    expect(choice.virtual?.decision.rejected).toEqual([])
  })

  test("only non-text candidates in scope is the existing 422, not a non-text selection", () => {
    const store = catalog([serving("a", NON_TEXT)])
    expect(() => chooseModel(routing, store, ALL, "auto", "messages")).toThrow(NoEligibleModelError)
  })

  test("only non-text candidates in scope: no virtual model is listed or probeable", () => {
    const store = catalog([serving("a", NON_TEXT)])
    expect(withVirtualModels(routing, store, ALL, [])).toEqual([])
    expect(() => virtualModelProbe(routing, store, ALL, "auto")).toThrow(ModelNotFoundError)
  })

  test.each(NON_TEXT)("a fixed request for %s passes through untouched", (model) => {
    const store = catalog([serving("a", NON_TEXT)])
    expect(chooseModel(routing, store, ALL, model, "messages")).toEqual({
      requestedModel: model,
      selectedModel: null,
      virtual: null,
    })
  })
})

describe("two names for one profile", () => {
  test("the winner is deterministic: equal profiles fall to the candidate name", () => {
    const store = catalog([serving("a", ["vendor/deep"]), serving("b", ["deep"])])
    const forward = chooseModel(routing, store, ALL, "auto", "messages")
    expect(forward.selectedModel).toBe("deep")
    expect(forward.virtual?.decision.ranked.map((r) => r.model)).toEqual(["deep", "vendor/deep"])
  })
})

describe("virtual discovery", () => {
  const store = catalog([serving("a", ["deep", "local/box"])])

  test("the real listing is untouched; active virtual models follow, router-owned and unsized", () => {
    const real = [
      {
        id: "deep",
        owner: "anthropic-api" as const,
        resolvedModel: null,
        contextTokens: 5,
        maxOutputTokens: 6,
      },
    ]
    const listed = withVirtualModels(routing, store, ALL, real)
    expect(listed[0]).toBe(real[0])
    expect(listed.slice(1).map((m) => m.id)).toEqual([
      "auto",
      "auto-fast",
      "auto-local",
      "auto-max",
      "auto-plan",
      "auto-research",
      "auto-review",
      "auto-task",
    ])
    for (const entry of listed.slice(1)) {
      expect(entry).toMatchObject({
        owner: "distpatch",
        resolvedModel: null,
        contextTokens: null,
        maxOutputTokens: null,
      })
    }
  })

  test("a virtual model with no eligible candidate under this key is not listed", () => {
    const remote = catalog([serving("a", ["deep"])])
    expect(withVirtualModels(routing, remote, ALL, []).map((m) => m.id)).not.toContain("auto-local")
  })

  test("a real name in the reserved namespace is dropped — no request could reach it", () => {
    const real = [
      {
        id: "auto-x",
        owner: "openai-api" as const,
        resolvedModel: null,
        contextTokens: null,
        maxOutputTokens: null,
      },
    ]
    expect(withVirtualModels(undefined, store, ALL, real)).toEqual([])
  })

  test("without a capability catalog nothing virtual is listed", () => {
    expect(withVirtualModels(undefined, store, ALL, [])).toEqual([])
  })

  test("the probe answers virtual names and leaves concrete ones to the concrete probe", () => {
    expect(virtualModelProbe(routing, store, ALL, "auto-task")).toMatchObject({
      id: "auto-task",
      owner: "distpatch",
    })
    expect(virtualModelProbe(routing, store, ALL, "deep")).toBeNull()
    expect(() => virtualModelProbe(routing, store, ALL, "auto-moe")).toThrow(ModelNotFoundError)
    expect(() =>
      virtualModelProbe(routing, catalog([serving("a", ["deep"])]), ALL, "auto-local"),
    ).toThrow(ModelNotFoundError)
  })
})
