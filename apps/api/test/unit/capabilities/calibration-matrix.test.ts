import { describe, expect, test } from "bun:test"
import {
  createMatrixCatalog,
  matrixCandidates,
  scoreSource,
} from "../../../bench/calibration/matrix-core"
import {
  CAPABILITY_SCHEMA_VERSION,
  SHIPPED_CAPABILITY_CATALOG,
} from "../../../src/services/capabilities"
import { selectVirtualModel, virtualModels } from "../../../src/services/virtual-models"

const firstProfile = SHIPPED_CAPABILITY_CATALOG.profiles[0]
if (firstProfile === undefined) throw new Error("the shipped catalog has no profiles")
const profile = firstProfile
const snapshot = {
  schemaVersion: CAPABILITY_SCHEMA_VERSION,
  revision: "snapshot-test",
  models: {
    [profile.id]: {
      scores: { general: 0.8 },
      dimensions: { general: { sources: ["https://example.com/aa"] } },
      sources: ["https://example.com/aa"],
    },
  },
}

describe("calibration matrix effective catalog", () => {
  test("reconstructs bootstrap profiles without losing decision-relevant fields", () => {
    const { base, rebuilt } = createMatrixCatalog(SHIPPED_CAPABILITY_CATALOG, null, null)
    expect(rebuilt.revision().effective).toBe(base.revision().effective)
    expect(
      rebuilt
        .list()
        .map((p) => [p.id, p.hard, p.scores, p.aliases, p.enabled, p.tags, p.family, p.baseModel]),
    ).toEqual(
      base
        .list()
        .map((p) => [p.id, p.hard, p.scores, p.aliases, p.enabled, p.tags, p.family, p.baseModel]),
    )
    const candidates = matrixCandidates(SHIPPED_CAPABILITY_CATALOG)
    for (const descriptor of virtualModels()) {
      expect(selectVirtualModel(rebuilt, descriptor, candidates).digest).toBe(
        selectVirtualModel(base, descriptor, candidates).digest,
      )
    }
  })

  test("reconstructs snapshot dimensions, null fallback, discovered profiles, and overrides", () => {
    const discovered = {
      ...profile,
      id: "matrix/discovered",
      aliases: ["matrix-alias"],
      enabled: false,
      hard: { ...profile.hard, textInput: false },
      scores: { ...profile.scores, general: 0.4 },
    }
    const payload = {
      ...snapshot,
      discoveredProfiles: [discovered],
      models: {
        ...snapshot.models,
        [profile.id]: { ...snapshot.models[profile.id], scores: { general: null, coding: 0.7 } },
      },
    }
    const override = {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      overrides: [{ id: profile.id, scores: { general: 0.8, coding: null } }],
    }
    const { base, rebuilt } = createMatrixCatalog(SHIPPED_CAPABILITY_CATALOG, payload, override)
    expect(rebuilt.revision().effective).toBe(base.revision().effective)
    expect(rebuilt.get(profile.id)?.scores).toEqual(base.get(profile.id)?.scores)
    expect(base.get(profile.id)?.scores.general).toBe(0.8)
    expect(base.get(profile.id)?.scores.coding).toBeNull()
    expect(base.get("matrix/discovered")?.enabled).toBe(false)
    expect(base.get("matrix/discovered")?.hard.textInput).toBe(false)
    expect(base.resolve("matrix-alias")?.id).toBe("matrix/discovered")
  })

  test("attributes compiled, bootstrap, equal/different override, and null override values correctly", () => {
    expect(scoreSource([], "general", 0.8, 0.8, ["artificial-analysis"])).toBe(
      "artificial-analysis",
    )
    expect(scoreSource([], "general", 0.4, null, ["artificial-analysis"])).toBe("bootstrap")
    expect(scoreSource([], "general", 0.4, undefined, undefined)).toBe("bootstrap")
    expect(scoreSource(["scores.general"], "general", 0.8, 0.8, ["artificial-analysis"])).toBe(
      "operator-override",
    )
    expect(scoreSource(["scores.general"], "general", 0.9, 0.8, ["artificial-analysis"])).toBe(
      "operator-override",
    )
    expect(scoreSource(["scores.general"], "general", null, 0.8, ["artificial-analysis"])).toBe(
      "operator-override",
    )
  })
})
