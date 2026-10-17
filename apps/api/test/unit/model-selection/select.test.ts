/**
 * Deterministic model selection over the capability catalog: hard eligibility, ranking,
 * tie-breaking and the versioned decision record.
 */

import { describe, expect, test } from "bun:test"
import { buildCapabilityCatalog } from "../../../src/services/capabilities"
import {
  ModelRequirements,
  type ModelSelectionDecision,
  type ModelSelectionInput,
  SelectionPolicy,
  selectModel,
} from "../../../src/services/model-selection"

const catalog = buildCapabilityCatalog({
  schemaVersion: 1,
  revision: "2026-10-17.1",
  profiles: [
    {
      id: "vendor/strong",
      aliases: ["strong-latest"],
      hard: { contextTokens: 200_000, toolUse: true, imageInput: true },
      scores: { coding: 0.9, speed: 0.3 },
    },
    {
      id: "vendor/fast",
      hard: { contextTokens: 32_000, toolUse: true, imageInput: false },
      scores: { coding: 0.6, speed: 0.9 },
    },
    { id: "vendor/sparse", hard: { toolUse: null }, scores: { coding: 0.9 } },
    { id: "vendor/twin-a", scores: { coding: 0.5 } },
    { id: "vendor/twin-b", scores: { coding: 0.5 } },
    { id: "vendor/half", scores: { coding: 0.25, speed: 0.25 } },
    { id: "local/box", tags: ["free", "local", "dockerlm"], hard: { toolUse: true } },
    { id: "vendor/off", enabled: false, scores: { coding: 1 } },
  ],
})

const policy = (body: Record<string, unknown> = {}) =>
  SelectionPolicy.parse({ id: "test", version: 1, weights: { coding: 1 }, ...body })

const select = (input: Partial<ModelSelectionInput> & { candidates: readonly string[] }) =>
  selectModel(catalog, { requirements: {}, policy: policy(), ...input })

const reasonsFor = (decision: ModelSelectionDecision, model: string) =>
  decision.rejected.find((r) => r.model === model)?.reasons

describe("determinism", () => {
  test("candidate order and duplicates do not change the decision or its digest", () => {
    const a = select({ candidates: ["vendor/fast", "strong-latest", "vendor/twin-a"] })
    const b = select({
      candidates: ["vendor/twin-a", "strong-latest", "vendor/fast", "vendor/fast"],
    })
    expect(b).toEqual(a)
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("tag order in requirements does not change the digest", () => {
    const a = select({
      candidates: ["local/box"],
      requirements: { requireTags: ["local", "free"] },
    })
    const b = select({
      candidates: ["local/box"],
      requirements: { requireTags: ["free", "local"] },
    })
    expect(b.digest).toBe(a.digest)
  })
})

describe("ranking", () => {
  test("weights decide: coding-heavy picks strong, speed-heavy picks fast", () => {
    const candidates = ["vendor/fast", "vendor/strong"]
    expect(select({ candidates }).selected?.profileId).toBe("vendor/strong")
    const speedy = policy({ weights: { coding: 1, speed: 3 } })
    expect(select({ candidates, policy: speedy }).selected?.profileId).toBe("vendor/fast")
  })

  test("an unknown weighted dimension earns no credit and is named", () => {
    const decision = select({
      candidates: ["vendor/sparse"],
      policy: policy({ weights: { coding: 1, speed: 1 } }),
    })
    expect(decision.selected).toMatchObject({
      score: 0.45,
      coverage: 0.5,
      unknownDimensions: ["speed"],
    })
  })

  test("equal score: higher coverage wins", () => {
    // twin-a: 0.5 coding, speed unknown → 0.25, coverage 0.5. half: 0.25, coverage 1.
    const decision = select({
      candidates: ["vendor/twin-a", "vendor/half"],
      policy: policy({ weights: { coding: 1, speed: 1 } }),
    })
    expect(decision.ranked.map((r) => [r.profileId, r.score, r.coverage])).toEqual([
      ["vendor/half", 0.25, 1],
      ["vendor/twin-a", 0.25, 0.5],
    ])
  })

  test("equal score and coverage: policy preference, then canonical id, then name", () => {
    const tied = ["vendor/twin-b", "vendor/twin-a"]
    expect(select({ candidates: tied }).selected?.profileId).toBe("vendor/twin-a")
    const preferB = policy({ preference: ["vendor/twin-b"] })
    expect(select({ candidates: tied, policy: preferB }).selected?.profileId).toBe("vendor/twin-b")
    const aliases = select({ candidates: ["strong-latest", "vendor/strong"] })
    expect(aliases.ranked.map((r) => r.model)).toEqual(["strong-latest", "vendor/strong"])
  })

  test("the selected model is the caller's name, not the canonical id", () => {
    const decision = select({ candidates: ["STRONG-latest"] })
    expect(decision.selected).toMatchObject({ model: "STRONG-latest", profileId: "vendor/strong" })
  })
})

describe("hard eligibility", () => {
  test("a known-unsupported or unknown required feature is rejected by default", () => {
    const decision = select({
      candidates: ["vendor/fast", "vendor/twin-a", "vendor/strong"],
      requirements: { imageInput: true },
    })
    expect(decision.selected?.profileId).toBe("vendor/strong")
    expect(reasonsFor(decision, "vendor/fast")).toEqual([
      { code: "feature", feature: "imageInput", value: false },
    ])
    expect(reasonsFor(decision, "vendor/twin-a")).toEqual([
      { code: "feature", feature: "imageInput", value: null },
    ])
  })

  test("`unknownHardFacts: accept` admits unknown, never known-unsupported", () => {
    const decision = select({
      candidates: ["vendor/fast", "vendor/twin-a"],
      requirements: { imageInput: true },
      policy: policy({ unknownHardFacts: "accept" }),
    })
    expect(decision.ranked.map((r) => r.profileId)).toEqual(["vendor/twin-a"])
    expect(decision.rejected.map((r) => r.model)).toEqual(["vendor/fast"])
  })

  test("context minimum: too small and unknown both fail", () => {
    const decision = select({
      candidates: ["vendor/fast", "vendor/strong", "vendor/twin-a"],
      requirements: { minContextTokens: 100_000 },
    })
    expect(decision.ranked.map((r) => r.profileId)).toEqual(["vendor/strong"])
    expect(reasonsFor(decision, "vendor/fast")).toEqual([
      { code: "limit", limit: "contextTokens", required: 100_000, value: 32_000 },
    ])
  })

  test("required and excluded semantic tags", () => {
    const local = select({
      candidates: ["local/box", "vendor/strong"],
      requirements: { requireTags: ["local"] },
    })
    expect(local.ranked.map((r) => r.profileId)).toEqual(["local/box"])
    const notFree = select({ candidates: ["local/box"], requirements: { excludeTags: ["free"] } })
    expect(reasonsFor(notFree, "local/box")).toEqual([{ code: "tag-excluded", tag: "free" }])
  })

  test("a floor on an unknown score is not met", () => {
    const decision = select({
      candidates: ["vendor/strong", "local/box"],
      policy: policy({ floors: { coding: 0.8 } }),
    })
    expect(decision.ranked.map((r) => r.profileId)).toEqual(["vendor/strong"])
    expect(reasonsFor(decision, "local/box")).toEqual([
      { code: "floor", dimension: "coding", floor: 0.8, value: null },
    ])
  })

  test("unprofiled and disabled models are rejected with their reason; every failed rule is listed", () => {
    const decision = select({
      candidates: ["brand-new-model", "vendor/off", "vendor/fast"],
      requirements: { imageInput: true, requireTags: ["local"] },
    })
    expect(decision.outcome).toBe("no-eligible-model")
    expect(decision.selected).toBeNull()
    expect(decision.rejected).toEqual([
      { model: "brand-new-model", profileId: null, reasons: [{ code: "no-profile" }] },
      {
        model: "vendor/fast",
        profileId: "vendor/fast",
        reasons: [
          { code: "feature", feature: "imageInput", value: false },
          { code: "tag-missing", tag: "local" },
        ],
      },
      {
        model: "vendor/off",
        profileId: "vendor/off",
        reasons: [
          { code: "disabled" },
          { code: "feature", feature: "imageInput", value: null },
          { code: "tag-missing", tag: "local" },
        ],
      },
    ])
  })
})

describe("versioned decision", () => {
  test("records selector version, policy identity and the catalog revision", () => {
    const decision = select({ candidates: ["vendor/strong"] })
    expect(decision.selectorVersion).toBe(1)
    expect(decision.policy).toMatchObject({ id: "test", version: 1 })
    expect(decision.catalogRevision).toEqual(catalog.revision())
  })

  test("a policy edit without a version bump still changes the policy digest", () => {
    const a = select({ candidates: ["vendor/strong"] })
    const b = select({ candidates: ["vendor/strong"], policy: policy({ weights: { coding: 2 } }) })
    expect(b.policy.version).toBe(a.policy.version)
    expect(b.policy.digest).not.toBe(a.policy.digest)
    expect(b.digest).not.toBe(a.digest)
  })

  test("a different catalog revision changes the decision digest", () => {
    const other = buildCapabilityCatalog({
      schemaVersion: 1,
      revision: "2026-10-17.2",
      profiles: [{ id: "vendor/strong", scores: { coding: 0.9 } }],
    })
    const input = { candidates: ["vendor/strong"], requirements: {}, policy: policy() }
    expect(selectModel(other, input).digest).not.toBe(selectModel(catalog, input).digest)
  })
})

describe("policy preference ids", () => {
  const parses = (preference: readonly string[]) =>
    SelectionPolicy.safeParse({ id: "p", version: 1, weights: { coding: 1 }, preference }).success

  test("a canonical `vendor/model` id is accepted", () => {
    expect(parses(["vendor/twin-b", "openai/gpt-5.5"])).toBe(true)
  })

  test.each([
    ["uppercase", "Vendor/Twin-B"],
    ["missing vendor", "twin-b"],
    ["empty model", "vendor/"],
    ["extra segment", "vendor/a/b"],
    ["whitespace", "vendor/twin b"],
    ["empty", ""],
  ])("%s is rejected", (_name, id) => {
    expect(parses([id])).toBe(false)
  })

  test("duplicates remain rejected", () => {
    expect(parses(["vendor/twin-a", "vendor/twin-a"])).toBe(false)
  })

  test("on an exact tie a valid preference changes the winner, independent of candidate order", () => {
    const preferB = policy({ preference: ["vendor/twin-b"] })
    const a = select({ candidates: ["vendor/twin-a", "vendor/twin-b"], policy: preferB })
    const b = select({ candidates: ["vendor/twin-b", "vendor/twin-a"], policy: preferB })
    expect(select({ candidates: ["vendor/twin-a", "vendor/twin-b"] }).selected?.profileId).toBe(
      "vendor/twin-a",
    )
    expect(a.selected).toMatchObject({ profileId: "vendor/twin-b", preferenceRank: 0 })
    expect(b).toEqual(a)
  })
})

describe("boundary schemas", () => {
  test("a policy with no positive weight is rejected", () => {
    expect(SelectionPolicy.safeParse({ id: "p", version: 1, weights: { coding: 0 } }).success).toBe(
      false,
    )
  })

  test("unknown keys and contradictory tags are rejected", () => {
    expect(SelectionPolicy.safeParse({ id: "p", version: 1, weights: { codng: 1 } }).success).toBe(
      false,
    )
    expect(ModelRequirements.safeParse({ vision: true }).success).toBe(false)
    expect(
      ModelRequirements.safeParse({ requireTags: ["free"], excludeTags: ["free"] }).success,
    ).toBe(false)
  })
})
