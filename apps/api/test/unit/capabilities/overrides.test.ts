/**
 * Operator overrides layered over the shipped catalog, and the revision that identifies the
 * effective result.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCapabilityCatalog,
  CapabilityCatalogError,
  loadCapabilityCatalog,
  SHIPPED_CAPABILITY_CATALOG,
} from "../../../src/services/capabilities"

const shipped = {
  schemaVersion: 1,
  revision: "2026-10-16.1",
  profiles: [
    {
      id: "vendor/alpha",
      aliases: ["alpha"],
      tags: ["premium"],
      hard: { toolUse: true },
      scores: { coding: 0.6 },
    },
    { id: "vendor/beta", tags: ["free"] },
  ],
}

const overrides = (body: Record<string, unknown>) => ({ schemaVersion: 1, ...body })
const build = (body: Record<string, unknown>) => buildCapabilityCatalog(shipped, overrides(body))

const problemsOf = (body: unknown): readonly string[] => {
  try {
    buildCapabilityCatalog(shipped, body)
  } catch (error) {
    if (error instanceof CapabilityCatalogError) return error.problems
    throw error
  }
  throw new Error("expected the overrides to be rejected")
}

describe("field overrides", () => {
  test("one field changes; everything else keeps its shipped value", () => {
    const alpha = build({ overrides: [{ id: "vendor/alpha", scores: { reasoning: 0.8 } }] }).get(
      "vendor/alpha",
    )
    expect(alpha?.scores.reasoning).toBe(0.8)
    expect(alpha?.scores.coding).toBe(0.6)
    expect(alpha?.scores.speed).toBeNull()
    expect(alpha?.hard.toolUse).toBe(true)
    expect(alpha?.overridden).toEqual(["scores.reasoning"])
  })

  test("several fields at once, and null resets a known value to unknown", () => {
    const alpha = build({
      overrides: [
        {
          id: "vendor/alpha",
          hard: { imageInput: true, contextTokens: 200_000 },
          scores: { coding: null },
        },
      ],
    }).get("vendor/alpha")
    expect(alpha?.hard.imageInput).toBe(true)
    expect(alpha?.hard.contextTokens).toBe(200_000)
    expect(alpha?.scores.coding).toBeNull()
    expect(alpha?.overridden).toEqual(["hard.contextTokens", "hard.imageInput", "scores.coding"])
  })

  test("tags: add/remove edit the list, set replaces it", () => {
    const edited = build({
      overrides: [{ id: "vendor/alpha", tags: { add: ["coding"], remove: ["premium"] } }],
    })
    expect(edited.get("vendor/alpha")?.tags).toEqual(["coding"])
    const replaced = build({
      overrides: [{ id: "vendor/beta", tags: { set: ["local", "dockerlm"] } }],
    })
    expect(replaced.get("vendor/beta")?.tags).toEqual(["dockerlm", "local"])
  })

  test("disabling keeps the profile resolvable, flagged", () => {
    const catalog = build({ overrides: [{ id: "vendor/alpha", enabled: false }] })
    expect(catalog.resolve("alpha")?.enabled).toBe(false)
    expect(catalog.get("vendor/beta")?.enabled).toBe(true)
  })

  test("an operator may add a whole profile", () => {
    const catalog = build({
      profiles: [{ id: "local/my-model", aliases: ["my-model"], tags: ["local"] }],
    })
    expect(catalog.resolve("my-model")?.origin).toBe("operator")
  })

  test("the shipped input is never mutated", () => {
    const before = JSON.stringify(SHIPPED_CAPABILITY_CATALOG)
    buildCapabilityCatalog(
      SHIPPED_CAPABILITY_CATALOG,
      overrides({ overrides: [{ id: "openai/gpt-5.5", enabled: false }] }),
    )
    expect(JSON.stringify(SHIPPED_CAPABILITY_CATALOG)).toBe(before)
  })
})

describe("rejected overrides", () => {
  const cases: readonly [string, unknown, string][] = [
    [
      "unknown target",
      overrides({ overrides: [{ id: "vendor/gamma" }] }),
      "no profile with this canonical id",
    ],
    [
      "alias as target",
      overrides({ overrides: [{ id: "alpha" }] }),
      "overrides.overrides[0] (alpha).id",
    ],
    [
      "duplicate target",
      overrides({ overrides: [{ id: "vendor/beta" }, { id: "vendor/beta", enabled: false }] }),
      "duplicate override target",
    ],
    [
      "secret field",
      overrides({ overrides: [{ id: "vendor/beta", apiKey: "sk-live" }] }),
      "apiKey",
    ],
    [
      "account field",
      overrides({ overrides: [{ id: "vendor/beta", accountIds: ["a"] }] }),
      "accountIds",
    ],
    [
      "bad score",
      overrides({ overrides: [{ id: "vendor/beta", scores: { cost: 2 } }] }),
      "scores.cost",
    ],
    [
      "set with add",
      overrides({ overrides: [{ id: "vendor/beta", tags: { set: ["a"], add: ["b"] } }] }),
      "`set` cannot be combined",
    ],
    [
      "add and remove the same tag",
      overrides({ overrides: [{ id: "vendor/beta", tags: { add: ["a"], remove: ["a"] } }] }),
      "both added and removed",
    ],
    ["wrong schema version", { schemaVersion: 9 }, "overrides.schemaVersion"],
    [
      "added profile duplicates shipped",
      overrides({ profiles: [{ id: "vendor/beta" }] }),
      "duplicate canonical id",
    ],
    [
      "added alias collides",
      overrides({ profiles: [{ id: "local/x", aliases: ["alpha"] }] }),
      "alias alpha is already an alias of",
    ],
  ]

  test.each(cases)("%s", (_name, body, fragment) => {
    expect(problemsOf(body).some((p) => p.includes(fragment))).toBe(true)
  })

  test("an override that makes tool_use scored while unsupported fails after merge", () => {
    expect(
      problemsOf(
        overrides({
          overrides: [{ id: "vendor/alpha", hard: { toolUse: false }, scores: { tool_use: 0.5 } }],
        }),
      ),
    ).toEqual(["profile vendor/alpha: scores.tool_use is set but hard.toolUse is false"])
  })
})

describe("revision", () => {
  test("identical effective contents give identical revisions, however reached", () => {
    const direct = buildCapabilityCatalog({
      ...shipped,
      profiles: [{ ...shipped.profiles[0], scores: { coding: 0.9 } }, shipped.profiles[1]],
    })
    const overridden = build({ overrides: [{ id: "vendor/alpha", scores: { coding: 0.9 } }] })
    expect(overridden.revision()).toEqual(direct.revision())
    expect(overridden.revision().effective).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("any effective change moves the effective revision but not the shipped one", () => {
    const base = buildCapabilityCatalog(shipped).revision()
    const changed = build({ overrides: [{ id: "vendor/beta", enabled: false }] }).revision()
    expect(changed.shipped).toBe(base.shipped)
    expect(changed.schemaVersion).toBe(1)
    expect(changed.effective).not.toBe(base.effective)
  })
})

describe("boot loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "capabilities-"))

  test("reads the override file once into the effective snapshot", () => {
    const path = join(dir, "ok.json")
    writeFileSync(
      path,
      JSON.stringify(overrides({ overrides: [{ id: "openai/gpt-5.5", enabled: false }] })),
    )
    expect(loadCapabilityCatalog(path).resolve("gpt-5.5")?.enabled).toBe(false)
  })

  test("a missing or non-JSON file fails rather than loading the shipped catalog alone", () => {
    const broken = join(dir, "broken.json")
    writeFileSync(broken, "{ not json")
    expect(() => loadCapabilityCatalog(join(dir, "absent.json"))).toThrow(CapabilityCatalogError)
    expect(() => loadCapabilityCatalog(broken)).toThrow(/not valid JSON/)
  })
})
