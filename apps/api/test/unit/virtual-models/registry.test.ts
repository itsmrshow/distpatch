/**
 * The virtual-model registry and its one meeting point with M2B: which names Distpatch owns, which
 * are active, and how a descriptor's static policy chooses among concrete candidates against an
 * injected capability catalog.
 */

import { describe, expect, test } from "bun:test"
import {
  buildCapabilityCatalog,
  type ModelCapabilityCatalog,
  SHIPPED_CAPABILITY_CATALOG,
} from "../../../src/services/capabilities"
import { ModelRequirements, SelectionPolicy } from "../../../src/services/model-selection"
import {
  isVirtualModelName,
  RESERVED_VIRTUAL_MODEL_IDS,
  selectVirtualModel,
  type VirtualModelDescriptor,
  virtualModel,
  virtualModels,
} from "../../../src/services/virtual-models"

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

/** Synthetic scores, for these tests only: nothing here is a measurement of a real model. */
const catalog = buildCapabilityCatalog({
  schemaVersion: 1,
  revision: "2026-10-17.1",
  profiles: [
    {
      id: "vendor/thinker",
      aliases: ["thinker"],
      hard: { toolUse: true },
      scores: { general: 0.8, reasoning: 0.95, long_context: 0.9, speed: 0.2, review: 0.7 },
    },
    {
      id: "vendor/sprinter",
      hard: { toolUse: true },
      scores: { general: 0.6, reasoning: 0.4, speed: 0.95, agentic: 0.5, tool_use: 0.6 },
    },
    {
      id: "vendor/agent",
      hard: { toolUse: true },
      scores: { general: 0.7, agentic: 0.95, tool_use: 0.95, reasoning: 0.6 },
    },
    { id: "vendor/no-tools", hard: { toolUse: false }, scores: { agentic: 1, general: 1 } },
    {
      id: "local/box",
      tags: ["local", "free"],
      hard: { toolUse: true },
      scores: { general: 0.4, reasoning: 0.3 },
    },
    { id: "local/quiet", tags: ["local"] },
    { id: "vendor/off", enabled: false, scores: { general: 1, reasoning: 1, speed: 1 } },
  ],
})

const ALL = [
  "thinker",
  "vendor/sprinter",
  "vendor/agent",
  "vendor/no-tools",
  "local/box",
  "local/quiet",
  "vendor/off",
  "uncatalogued-model",
]

function descriptor(id: string): VirtualModelDescriptor {
  const found = virtualModel(id)
  if (found === null) throw new Error(`${id} is not active`)
  return found
}

const winner = (id: string, candidates: readonly string[] = ALL) =>
  selectVirtualModel(catalog, descriptor(id), candidates).selected?.model ?? null

describe("registry", () => {
  test("exactly the documented virtual models are active, each id unique", () => {
    const ids = virtualModels().map((d) => d.id)
    expect(ids).toEqual(ACTIVE)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every descriptor re-validates through the M2B schemas and is frozen", () => {
    for (const d of virtualModels()) {
      expect(SelectionPolicy.parse(d.policy)).toEqual(d.policy)
      expect(ModelRequirements.parse(d.requirements)).toEqual(d.requirements)
      expect(Object.isFrozen(d)).toBe(true)
      expect(Object.isFrozen(d.policy.weights)).toBe(true)
    }
  })

  test("policy ids and versions are the virtual ids at version 1 — a change is deliberate", () => {
    expect(virtualModels().map((d) => [d.policy.id, d.policy.version])).toEqual(
      ACTIVE.map((id) => [id, 1]),
    )
  })

  test("no descriptor embeds a model ranking, a provider or an account", () => {
    for (const d of virtualModels()) {
      expect(d.policy.preference).toBeUndefined()
      expect(Object.keys(d).sort()).toEqual(["id", "intent", "policy", "requirements"])
    }
  })

  test("auto-local requires the local tag; auto-task requires tool use; the rest add nothing hard", () => {
    expect(descriptor("auto-local").requirements).toEqual({ requireTags: ["local"] })
    expect(descriptor("auto-task").requirements).toEqual({ toolUse: true })
    for (const id of ACTIVE.filter((id) => id !== "auto-local" && id !== "auto-task")) {
      expect(descriptor(id).requirements).toEqual({})
    }
  })
})

describe("namespace", () => {
  test.each([
    "auto",
    "auto-task",
    "auto-does-not-exist",
    "AUTO",
    "Auto-Task",
    "auto[1m]",
    "auto-task[1m]",
    "auto-",
  ])("%s is reserved", (name) => {
    expect(isVirtualModelName(name)).toBe(true)
  })

  test.each(["automatic", "autopilot-1", "gpt-auto", "openrouter/auto", "claude-opus-5"])(
    "%s is a concrete name",
    (name) => {
      expect(isVirtualModelName(name)).toBe(false)
    },
  )

  test("lookup is exact: no case folding, no prefix or fuzzy match", () => {
    for (const name of ["AUTO", "Auto-Task", "auto-tas", "auto-task ", "auto-task[1m]", "auto-"]) {
      expect(virtualModel(name)).toBeNull()
    }
  })

  test("auto-moe and auto-free are reserved but not active", () => {
    expect(RESERVED_VIRTUAL_MODEL_IDS).toEqual(["auto-free", "auto-moe"])
    for (const id of RESERVED_VIRTUAL_MODEL_IDS) {
      expect(isVirtualModelName(id)).toBe(true)
      expect(virtualModel(id)).toBeNull()
    }
  })
})

describe("resolution", () => {
  test("each policy's intent shows in which synthetic profile wins", () => {
    expect(winner("auto-research")).toBe("thinker")
    expect(winner("auto-fast")).toBe("vendor/sprinter")
    expect(winner("auto-task")).toBe("vendor/agent")
    expect(winner("auto-local")).toBe("local/box")
  })

  test("candidate order and duplicates change neither the winner nor the digest", () => {
    for (const id of ACTIVE) {
      const forward = selectVirtualModel(catalog, descriptor(id), ALL)
      const reversed = selectVirtualModel(catalog, descriptor(id), [...ALL, ...ALL].reverse())
      expect(reversed).toEqual(forward)
      expect(reversed.digest).toBe(forward.digest)
    }
  })

  test("the decision names the virtual policy and the injected catalog's revision", () => {
    const decision = selectVirtualModel(catalog, descriptor("auto-plan"), ALL)
    expect(decision.policy).toMatchObject({ id: "auto-plan", version: 1 })
    expect(decision.catalogRevision).toEqual(catalog.revision())
  })

  test("an operator-disabled profile is never selected, whatever it scores", () => {
    for (const id of ACTIVE) {
      expect(winner(id)).not.toBe("vendor/off")
    }
    expect(
      selectVirtualModel(catalog, descriptor("auto"), ALL).rejected.find(
        (r) => r.model === "vendor/off",
      )?.reasons,
    ).toContainEqual({ code: "disabled" })
  })

  test("auto-local admits only profiles tagged local", () => {
    const decision = selectVirtualModel(catalog, descriptor("auto-local"), ALL)
    expect(decision.ranked.map((r) => r.profileId).sort()).toEqual(["local/box", "local/quiet"])
  })

  test("auto-task rejects a known tool-less model and an unknown one alike", () => {
    const decision = selectVirtualModel(catalog, descriptor("auto-task"), ALL)
    expect(decision.rejected.find((r) => r.model === "vendor/no-tools")?.reasons).toContainEqual({
      code: "feature",
      feature: "toolUse",
      value: false,
    })
    expect(decision.rejected.find((r) => r.model === "local/quiet")?.reasons).toContainEqual({
      code: "feature",
      feature: "toolUse",
      value: null,
    })
  })

  test("an uncatalogued or absent candidate set is no-eligible-model, not an exception", () => {
    expect(winner("auto", ["uncatalogued-model"])).toBeNull()
    expect(selectVirtualModel(catalog, descriptor("auto"), []).outcome).toBe("no-eligible-model")
    expect(winner("auto-local", ["thinker", "vendor/agent"])).toBeNull()
  })

  test("auto-free is not faked through a model tag: `free` profiles get no special route", () => {
    // The only path to `free` would be a semantic tag requirement; no active descriptor has one.
    for (const d of virtualModels()) {
      expect(d.requirements.requireTags ?? []).not.toContain("free")
    }
  })

  test("shipped data carries no scores, so unknown stays unknown and ties fall to canonical id", () => {
    const shipped = buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG, null)
    const decision = selectVirtualModel(shipped, descriptor("auto-max"), [
      "gpt-5.5",
      "claude-sonnet-4-6",
    ])
    expect(decision.ranked.map((r) => [r.model, r.score, r.coverage])).toEqual([
      ["claude-sonnet-4-6", 0, 0],
      ["gpt-5.5", 0, 0],
    ])
  })

  test("reads only the injected catalog, synchronously — resolve and revision, nothing else", () => {
    const calls: string[] = []
    const spy: ModelCapabilityCatalog = {
      resolve: (model) => {
        calls.push(`resolve:${model}`)
        return catalog.resolve(model)
      },
      get: () => {
        throw new Error("get must not be needed")
      },
      list: () => {
        throw new Error("list must not be needed")
      },
      revision: () => {
        calls.push("revision")
        return catalog.revision()
      },
    }
    const decision = selectVirtualModel(spy, descriptor("auto"), ["thinker", "local/box"])
    expect(decision).not.toBeInstanceOf(Promise)
    expect(calls).toEqual(["resolve:local/box", "resolve:thinker", "revision"])
  })
})
