/**
 * The model capability catalog's load-time contract: schema failures, unknown preservation,
 * identity/alias resolution, and the missing-profile result.
 */

import { describe, expect, test } from "bun:test"
import {
  buildCapabilityCatalog,
  CAPABILITY_DIMENSIONS,
  CapabilityCatalogError,
  SHIPPED_CAPABILITY_CATALOG,
  type ShippedCatalogInput,
} from "../../../src/services/capabilities"
import { filterCandidates } from "../../../src/services/routing"
import { account, NOW, scoped } from "../routing/fixtures"

type Profile = ShippedCatalogInput["profiles"][number]

const catalogOf = (profiles: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  revision: "2026-10-16.1",
  profiles,
  ...extra,
})

const problemsOf = (shipped: unknown, overrides: unknown = null): readonly string[] => {
  try {
    buildCapabilityCatalog(shipped, overrides)
  } catch (error) {
    if (error instanceof CapabilityCatalogError) return error.problems
    throw error
  }
  throw new Error("expected the catalog to be rejected")
}

const sparse: Profile = { id: "vendor/sparse-1", aliases: ["sparse-1"] }

describe("shipped catalog", () => {
  test("loads, sorted by id, every profile enabled and shipped", () => {
    const catalog = buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG)
    const ids = catalog.list().map((p) => p.id)
    expect(ids).toEqual([...ids].sort())
    expect(catalog.list().every((p) => p.enabled && p.origin === "shipped")).toBe(true)
    expect(catalog.revision().shipped).toBe(SHIPPED_CAPABILITY_CATALOG.revision)
  })

  test("represents the local/free/dockerlm tags on the DockerLM model", () => {
    const profile = buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG).resolve(
      "mimo-v2.6-distill-9b",
    )
    expect(profile?.tags).toEqual(["dockerlm", "free", "local"])
  })

  test("ships no invented preference score", () => {
    for (const profile of buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG).list()) {
      for (const dimension of CAPABILITY_DIMENSIONS) expect(profile.scores[dimension]).toBeNull()
    }
  })
})

describe("schema failures", () => {
  const cases: readonly [string, unknown, string][] = [
    [
      "unsupported schema version",
      { ...catalogOf([sparse]), schemaVersion: 2 },
      "shipped.schemaVersion",
    ],
    ["malformed id", catalogOf([{ id: "No Slash" }]), "profiles[0] (No Slash).id"],
    ["typo field", catalogOf([{ ...sparse, scroes: {} }]), "profiles[0] (vendor/sparse-1)"],
    ["account id smuggled in", catalogOf([{ ...sparse, accountId: "acc_1" }]), "accountId"],
    ["credential smuggled in", catalogOf([{ ...sparse, hard: { apiKey: "sk-x" } }]), "apiKey"],
    ["score above 1", catalogOf([{ ...sparse, scores: { coding: 1.5 } }]), "scores.coding"],
    ["negative score", catalogOf([{ ...sparse, scores: { speed: -0.1 } }]), "scores.speed"],
    ["NaN score", catalogOf([{ ...sparse, scores: { general: Number.NaN } }]), "scores.general"],
    [
      "infinite context",
      catalogOf([{ ...sparse, hard: { contextTokens: Infinity } }]),
      "contextTokens",
    ],
    [
      "negative output",
      catalogOf([{ ...sparse, hard: { maxOutputTokens: -1 } }]),
      "maxOutputTokens",
    ],
    ["invalid tag", catalogOf([{ ...sparse, tags: ["Free Tier"] }]), "tags"],
    ["duplicate tag", catalogOf([{ ...sparse, tags: ["free", "free"] }]), "tags"],
    [
      "source with query",
      catalogOf([{ ...sparse, sources: ["https://x.io/a?token=1"] }]),
      "sources",
    ],
    ["bad revision", { ...catalogOf([sparse]), revision: "latest" }, "shipped.revision"],
  ]

  test.each(cases)("%s fails, naming the entry", (_name, shipped, fragment) => {
    expect(problemsOf(shipped).some((p) => p.includes(fragment))).toBe(true)
  })

  test("duplicate canonical id fails", () => {
    expect(problemsOf(catalogOf([sparse, { id: sparse.id }]))).toEqual([
      "shipped profile vendor/sparse-1: duplicate canonical id",
    ])
  })

  test("contradictory hard facts fail", () => {
    const problems = problemsOf(
      catalogOf([
        { id: "a/out-over-context", hard: { contextTokens: 1000, maxOutputTokens: 2000 } },
        { id: "a/tools-no-text", hard: { textOutput: false, toolUse: true } },
        { id: "a/blind-but-scored", hard: { imageInput: false }, scores: { vision: 0.4 } },
      ]),
    )
    expect(problems).toEqual([
      "profile a/blind-but-scored: scores.vision is set but hard.imageInput is false",
      "profile a/out-over-context: hard.maxOutputTokens exceeds hard.contextTokens",
      "profile a/tools-no-text: tool use / structured output require hard.textOutput",
    ])
  })
})

describe("unknown stays unknown", () => {
  test("omitted facts and scores are null, never 0 or false", () => {
    const profile = buildCapabilityCatalog(catalogOf([sparse])).get("vendor/sparse-1")
    expect(Object.values(profile?.hard ?? {}).every((v) => v === null)).toBe(true)
    expect(Object.values(profile?.scores ?? {}).every((v) => v === null)).toBe(true)
    expect(profile?.family).toBeNull()
  })

  test("a partial profile keeps its known values and its unknowns", () => {
    const profile = buildCapabilityCatalog(
      catalogOf([{ id: "vendor/p", hard: { imageInput: false }, scores: { coding: 0.7 } }]),
    ).get("vendor/p")
    expect(profile?.hard.imageInput).toBe(false)
    expect(profile?.hard.toolUse).toBeNull()
    expect(profile?.scores.coding).toBe(0.7)
    expect(profile?.scores.reasoning).toBeNull()
  })

  test("unknown survives serialization as null", () => {
    const json = JSON.parse(JSON.stringify(buildCapabilityCatalog(catalogOf([sparse])).list()))
    expect(json[0].scores.speed).toBeNull()
    expect(json[0].hard.contextTokens).toBeNull()
  })
})

describe("identity", () => {
  const catalog = buildCapabilityCatalog(
    catalogOf([
      {
        id: "openai/gpt-oss-120b",
        family: "gpt-oss",
        aliases: ["gpt-oss-120b"],
      },
      { id: "openai/gpt-oss-20b", family: "gpt-oss", aliases: ["gpt-oss-20b"] },
    ]),
  )

  test("canonical id and every explicit alias resolve to one profile", () => {
    const profile = catalog.get("openai/gpt-oss-120b")
    expect(catalog.resolve("gpt-oss-120b")).toBe(profile)
    expect(catalog.resolve("GPT-OSS-120B")).toBe(profile)
  })

  test("a family groups profiles without merging them", () => {
    expect(
      catalog
        .list()
        .filter((p) => p.family === "gpt-oss")
        .map((p) => p.id),
    ).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"])
    expect(catalog.resolve("gpt-oss")).toBeNull()
  })

  test("no fuzzy matching: a similar name is a miss", () => {
    expect(catalog.resolve("gpt-oss-120b-medium")).toBeNull()
    expect(catalog.resolve("120b")).toBeNull()
  })

  test("an alias claimed twice, or equal to a canonical id, is rejected", () => {
    expect(
      problemsOf(
        catalogOf([
          { id: "a/one", aliases: ["shared"] },
          { id: "a/two", aliases: ["shared", "a/one"] },
        ]),
      ),
    ).toEqual([
      "profile a/two: alias a/one collides with canonical id a/one",
      "profile a/two: alias shared is already an alias of a/one",
    ])
  })

  test("resolution exposes no wire name and leaves its input untouched", () => {
    const name = "gpt-oss-120b"
    const profile = catalog.resolve(name)
    expect(name).toBe("gpt-oss-120b")
    expect(Object.keys(profile ?? {})).not.toContain("upstreamModel")
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile?.scores)).toBe(true)
  })
})

describe("missing profiles", () => {
  const catalog = buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG)

  test("an uncatalogued model resolves to null, not an inferred profile", () => {
    expect(catalog.resolve("brand-new-local-model")).toBeNull()
    expect(catalog.get("brand-new-local-model")).toBeNull()
  })

  test("fixed-model routing still serves a model the catalog does not know", () => {
    const model = "brand-new-local-model"
    const result = filterCandidates(
      [scoped(account("dockerlm", { provider: "ollama", supportedModels: [model] }), 0)],
      model,
      NOW,
    )
    expect(result.eligible.map((c) => c.account.id)).toEqual(["dockerlm"])
    expect(catalog.resolve(model)).toBeNull()
  })
})
