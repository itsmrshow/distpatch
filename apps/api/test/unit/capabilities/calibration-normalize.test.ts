/**
 * `distpatch-norm-v1` (apps/api/bench/calibration/normalize.ts): the rule that turns calibration
 * grades into catalog scores. The shipped catalog is only as trustworthy as these properties.
 */

import { describe, expect, test } from "bun:test"
import { type ModelRun, normalize } from "../../../bench/calibration/normalize"

const SUITE = "suite-x"
const CASES = [
  { id: "g1", dimension: "general" },
  { id: "g2", dimension: "general" },
  { id: "c1", dimension: "coding" },
  { id: "t1", dimension: "tool_use" },
] as const

const run = (profileId: string, grades: Record<string, number | null>): ModelRun => ({
  profileId,
  suite: SUITE,
  cases: CASES.filter((c) => c.id in grades).map((c) => ({ ...c, grade: grades[c.id] ?? null })),
})

describe("distpatch-norm-v1", () => {
  test("a score is the mean over cases of the mean over runs, to two decimals", () => {
    const { raw } = normalize(
      [
        run("a/x", { g1: 1, g2: 0.5 }),
        run("a/x", { g1: 0, g2: 0.5 }),
        run("b/y", { g1: 1, g2: 1 }),
      ],
      CASES,
      SUITE,
    )
    // g1: (1 + 0) / 2 = 0.5; g2: 0.5 → general 0.5
    expect(raw["a/x"]?.general).toBe(0.5)
  })

  test("a dimension with any unrun case stays unknown — never extrapolated from the rest", () => {
    const { raw } = normalize([run("a/x", { g1: 1, g2: null, c1: 0.2 })], CASES, SUITE)
    expect(raw["a/x"]?.general).toBeNull()
    expect(raw["a/x"]?.coding).toBe(0.2)
    expect(raw["a/x"]?.tool_use).toBeNull()
  })

  test("adding a model never changes an already-published value", () => {
    const before = normalize([run("a/x", { g1: 0.5, g2: 1, c1: 0.4 })], CASES, SUITE).scores
    const after = normalize(
      [run("a/x", { g1: 0.5, g2: 1, c1: 0.4 }), run("z/extreme", { g1: 0, g2: 0, c1: 1 })],
      CASES,
      SUITE,
    ).scores
    expect(after["a/x"]).toEqual(before["a/x"])
  })

  test("a dimension every measured model clears above the ceiling is withheld, not published as 1.0", () => {
    const { scores, saturated, raw } = normalize(
      [run("a/x", { c1: 1, t1: 0.95 }), run("b/y", { c1: 0.5, t1: 1 })],
      CASES,
      SUITE,
    )
    expect(saturated).toEqual(["tool_use"])
    expect(raw["a/x"]?.tool_use).toBe(0.95)
    expect(scores["a/x"]?.tool_use).toBeNull()
    expect(scores["a/x"]?.coding).toBe(1)
    expect(scores["b/y"]?.coding).toBe(0.5)
  })

  test("results from another suite version are refused, not mixed", () => {
    expect(() => normalize([{ ...run("a/x", { g1: 1 }), suite: "older" }], CASES, SUITE)).toThrow()
  })
})
