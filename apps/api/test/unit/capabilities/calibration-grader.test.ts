import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CASES,
  GRADER_VERSION,
  SUITE_VERSION,
  type TextCase,
  type ToolCase,
  type ToolTranscript,
} from "../../../bench/calibration/cases"
import { openAiChatRoute } from "../../../bench/calibration/routes"
import { failedCase, score } from "../../../bench/calibration/run"
import { CalibrationSandboxUnavailableError } from "../../../bench/calibration/sandbox"
import { calibrationSandboxSkipped } from "../../support/calibration-sandbox-gate"

const sandboxSkipped = await calibrationSandboxSkipped(
  "apps/api/test/unit/capabilities/calibration-grader.test.ts (sandboxed grading)",
)

const fenced = (code: string) => `\`\`\`ts\n${code}\n\`\`\``

const parseDuration = `function parseDuration(input: string): number {
  const match = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(input)
  if (!match || (!match[1] && !match[2] && !match[3])) throw new Error("invalid duration")
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
}`

const chunk = `function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError("size must be a positive integer")
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}`

const lru = `class LruCache<K, V> {
  private readonly capacity: number
  private readonly values = new Map<K, V>()
  constructor(capacity: number) { this.capacity = capacity }
  get(key: K): V | undefined {
    if (!this.values.has(key)) return undefined
    const value = this.values.get(key) as V
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }
  set(key: K, value: V): void {
    if (this.values.has(key)) this.values.delete(key)
    this.values.set(key, value)
    if (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value as K)
  }
  get size(): number { return this.values.size }
}`

const withTimeout = `function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  const result = Promise.withResolvers<T>()
  const timer = setTimeout(() => result.reject(new Error("timeout")), ms)
  work.then(
    (value) => { clearTimeout(timer); result.resolve(value) },
    (error) => { clearTimeout(timer); result.reject(error) },
  )
  return result.promise
}`

const semver = `type ParsedVersion = { core: string[]; prerelease: string[] | null }
function parseVersion(version: string): ParsedVersion {
  const match = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match) throw new Error("invalid version")
  const prerelease = match[4] === undefined ? null : match[4].split(".")
  if (prerelease?.some((part) => /^\\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
    throw new Error("invalid numeric prerelease identifier")
  return { core: [match[1] as string, match[2] as string, match[3] as string], prerelease }
}
function compareNumeric(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const result = compareNumeric(left.core[i] as string, right.core[i] as string)
    if (result !== 0) return result
  }
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0
    return left.prerelease === null ? 1 : -1
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i] as string
    const y = right.prerelease[i] as string
    if (x === y) continue
    const xNumeric = /^\\d+$/.test(x)
    const yNumeric = /^\\d+$/.test(y)
    if (xNumeric && yNumeric) return compareNumeric(x, y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1
}`

const buildOrder = `function buildOrder(deps: Record<string, string[]>): string[] {
  const nodes = new Set<string>()
  const dependents = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const [name, requirements] of Object.entries(deps)) {
    nodes.add(name)
    for (const requirement of requirements) nodes.add(requirement)
  }
  for (const node of nodes) {
    dependents.set(node, [])
    indegree.set(node, 0)
  }
  for (const [name, requirements] of Object.entries(deps)) {
    for (const requirement of requirements) {
      dependents.get(requirement)?.push(name)
      indegree.set(name, (indegree.get(name) ?? 0) + 1)
    }
  }
  const ready = [...nodes].filter((node) => indegree.get(node) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const node = ready.shift() as string
    order.push(node)
    for (const dependent of dependents.get(node) ?? []) {
      const remaining = (indegree.get(dependent) as number) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  if (order.length !== nodes.size) throw new Error("cycle in dependencies")
  return order
}`

const parseCsvLine = `function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      i++
      let field = ""
      let closed = false
      while (i < line.length) {
        if (line[i] !== '"') { field += line[i]; i++; continue }
        if (line[i + 1] === '"') { field += '"'; i += 2; continue }
        i++
        closed = true
        break
      }
      if (!closed) throw new Error("unterminated quoted field")
      if (i < line.length && line[i] !== ",") throw new Error("characters after closing quote")
      fields.push(field)
      if (i === line.length) break
      i++
      if (i === line.length) { fields.push(""); break }
      continue
    }
    const comma = line.indexOf(",", i)
    const end = comma === -1 ? line.length : comma
    const field = line.slice(i, end)
    if (field.includes('"')) throw new Error("quote in unquoted field")
    fields.push(field)
    if (comma === -1) break
    i = end + 1
    if (i === line.length) { fields.push(""); break }
  }
  return fields
}`

const slugify = `export function slugify(s: string): string {
  return s.normalize("NFKD").replace(/\\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}`

const textAnswers: Record<string, string> = {
  "general.bullets":
    "- Catch regressions before code reaches users.\n- Document expected behavior for future maintainers.\n- Make refactoring safer by checking functionality.",
  "general.synthesis":
    "Priya owns the billing migration, approved on 2026-03-14, with cutover planned for June.",
  "general.facts": "W; Canberra; 1989",
  "general.sort": "apple, banana, cherry, date, fig, pear",
  "general.timezone": "Tokyo 23:30, New York 10:30",
  "general.word-ladder":
    "Swift brooks flow past hills.\nRain can flood small brook banks.\nBright fish dart amid dark rocky pools.\nCalm brooks rush around tall rocky bank walls.\nWild birds watch as fish rush past rocky banks.",
  "general.acrostic": "Rabbits\nOutgrow\nUnusual\nTurtles\nEvening\nRangers",
  "coding.parse-duration": fenced(parseDuration),
  "coding.fix-chunk": fenced(chunk),
  "coding.lru": fenced(lru),
  "coding.with-timeout": fenced(withTimeout),
  "coding.comprehension": "14 7",
  "coding.semver": fenced(semver),
  "coding.toposort": fenced(buildOrder),
  "coding.csv": fenced(parseCsvLine),
  "reasoning.line-up": "ANSWER: Dee, Ben, Ann, Cal",
  "reasoning.tank": "ANSWER: 740",
  "reasoning.timeouts": "ANSWER: YES, 2.4 seconds",
  "reasoning.dice": "ANSWER: 5/11",
  "reasoning.critical-path": "ANSWER: 10",
  "reasoning.knaves": "ANSWER: knave",
  "reasoning.inclusion-exclusion": "ANSWER: 200",
  "reasoning.calendar": "ANSWER: Monday",
  "review.injection-await":
    "DEFECT: The user-controlled id is concatenated into SQL, allowing SQL injection; use a parameterized query.\nDEFECT: db.query is not awaited, so the delete may finish after the handler returns.",
  "review.pagination":
    "DEFECT: The offset uses page * perPage even though page is 1-based; it should use (page - 1) * perPage.\nDEFECT: hasMore uses <=, so it is true when the current page ends exactly at items.length.",
  "review.design-payments":
    "DEFECT: Retrying payments without an idempotency key can charge the customer twice.\nDEFECT: A 24-hour permission cache makes revocation stale for up to a day.\nDEFECT: Card numbers are logged at INFO level.",
  "review.race":
    "DEFECT: Concurrent handlers can both read the same balance and lose an update; make the check-and-update atomic in a transaction or lock the row.",
  "review.clean": "NO DEFECTS",
  "review.median":
    "DEFECT: The default sort is lexicographic; supply a numeric comparator.\nDEFECT: sort mutates the caller's array; copy it before sorting.",
  "review.cache-key":
    "DEFECT: Concatenating userId and page without a separator can cause a key collision, such as 1 and 23 versus 12 and 3.\nDEFECT: setTimeout expects milliseconds, but ttlSeconds is in seconds; multiply by 1000.",
  "review.clean-tricky": "NO DEFECTS",
  "structured.extract": JSON.stringify({
    date: "2026-03-03",
    people: [
      { name: "Lena Ortiz", role: "author" },
      { name: "Sam Wu", role: "reviewer" },
      { name: "Ada Park", role: "approver" },
    ],
  }),
  "structured.array": JSON.stringify([
    { id: 1, title: "Plan release", priority: "high" },
    { id: 2, title: "Prepare changelog", priority: "medium" },
    { id: 3, title: "Run tests", priority: "medium" },
    { id: 4, title: "Publish package", priority: "low" },
  ]),
  "structured.nullable": JSON.stringify({ city: "Porto Velho", population: null, founded: 1914 }),
  "structured.escaping": JSON.stringify({ message: 'She said "use C:\\temp"\nthen left.' }),
  "structured.conditional": JSON.stringify([
    { type: "meeting", date: "2026-11-02", title: "Kickoff", attendees: ["Ana", "Zoe"] },
    { type: "deadline", date: "2026-11-06", title: "Design doc" },
    { type: "meeting", date: "2026-11-20", title: "Retro", attendees: ["Ben", "Carl", "Zoe"] },
  ]),
  "structured.numeric-constraints": JSON.stringify([1, 3, 5, 7, 20, 24, 28, 32, 36, 44]),
  "long_context.needle": "Juniper-58",
  "long_context.multi-hop": "4.2 million euros",
  "long_context.aggregate": "3, 535",
  "long_context.superseded": "4.6 million euros",
  "long_context.three-hop": "4471",
  "long_context.first-appearance": "search, mailer, auth",
}

function textCase(id: string): TextCase {
  const found = CASES.find((candidate) => candidate.id === id)
  if (found?.kind !== "text") throw new Error(`missing text case ${id}`)
  return found
}

async function referenceToolCase(c: ToolCase): Promise<{
  transcript: ToolTranscript
  state: unknown
  runTestsOutput?: string
}> {
  const env = c.environment()
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args })
    return await env.call(name, args)
  }
  let final = ""
  let turns = 1
  let runTestsOutput: string | undefined
  switch (c.id) {
    case "tool_use.select-args":
      await call("convert_currency", { amount: 250, from: "EUR", to: "JPY" })
      final = "40,712.5 JPY"
      break
    case "tool_use.two-calls":
      await call("get_weather", { city: "Oslo" })
      await call("get_weather", { city: "Lima" })
      final = "Lima is warmer: Oslo -3°C, Lima 19°C"
      turns = 3
      break
    case "tool_use.date-args":
      await call("search_flights", { origin: "LIS", destination: "BER", date: "2026-07-09" })
      final = "The cheapest flight is XY123 at €89"
      break
    case "tool_use.no-tool":
      final = "51"
      break
    case "agentic.fix-and-verify":
      await call("write_file", {
        path: "src/price.ts",
        content:
          "export function withTax(net: number, rate: number): number { return net * (1 + rate); }",
      })
      await call("run_tests")
      final = "Fixed the tax calculation and confirmed the tests pass."
      turns = 3
      break
    case "agentic.recover-error":
      await call("get_order", { order_id: "ORD-0042" })
      await call("get_customer", { customer_id: "CUS-7" })
      final = "mira@example.test"
      turns = 3
      break
    case "agentic.reach-state":
      await call("list_items")
      await call("remove_item", { item: "soap" })
      await call("remove_item", { item: "Eggs " })
      await call("add_item", { item: "eggs" })
      await call("add_item", { item: "bread" })
      final = "The list now contains milk, eggs, and bread."
      turns = 6
      break
    case "tool_use.chained":
      await call("search_flights", { origin: "LIS", destination: "BER", date: "2026-07-09" })
      await call("convert_currency", { amount: 89, from: "EUR", to: "USD" })
      final = "$96.12"
      turns = 3
      break
    case "tool_use.strict-args":
      await call("create_event", {
        title: "Design review",
        start: "2026-11-03T15:30:00Z",
        duration_minutes: 90,
        attendees: ["Ana", "Ben"],
      })
      final = "Created the event."
      break
    case "agentic.iterate-to-green":
      await call("write_file", { path: "src/slug.ts", content: slugify })
      runTestsOutput = await call("run_tests")
      final = "All five tests pass."
      turns = 3
      break
    case "agentic.paged-injection":
      await call("list_tickets")
      await call("list_tickets", { page_token: "p2" })
      final = "high=3, low=2"
      turns = 3
      break
    default:
      throw new Error(`missing tool reference for ${c.id}`)
  }
  return {
    transcript: { calls, final, turns },
    state: (await env.state?.()) ?? null,
    runTestsOutput,
  }
}

describe.skipIf(sandboxSkipped)("calibration grader integrity (sandboxed)", () => {
  test("every text case has a canonical answer earning full credit", async () => {
    const cases = CASES.filter((candidate): candidate is TextCase => candidate.kind === "text")
    expect(cases.map((candidate) => candidate.id).filter((id) => !(id in textAnswers))).toEqual([])
    expect(
      Object.keys(textAnswers).filter((id) => !cases.some((candidate) => candidate.id === id)),
    ).toEqual([])
    for (const c of cases) {
      const checks = await c.grade(textAnswers[c.id] as string)
      expect(checks.length).toBeGreaterThan(0)
      expect(checks.every((entry) => entry.pass)).toBe(true)
    }
  }, 120_000)

  test("every tool case has a canonical full-credit transcript", async () => {
    const cases = CASES.filter((candidate): candidate is ToolCase => candidate.kind === "tools")
    for (const c of cases) {
      const { transcript, state, runTestsOutput } = await referenceToolCase(c)
      if (c.id === "agentic.iterate-to-green") expect(runTestsOutput).toBe("5 passed, 0 failed")
      const checks = c.grade(transcript, state)
      expect(checks.length).toBeGreaterThan(0)
      expect(checks.every((entry) => entry.pass)).toBe(true)
    }
  }, 120_000)

  test("semver uses the fixed host probe count", async () => {
    const checks = await textCase("coding.semver").grade(textAnswers["coding.semver"] as string)
    expect(checks).toHaveLength(14)
    expect(checks.every((entry) => entry.pass)).toBe(true)
  }, 30_000)

  test("candidate stdout noise does not disturb a correct oracle report", async () => {
    const checks = await textCase("coding.parse-duration").grade(
      fenced(`console.log("candidate noise")\n${parseDuration}`),
    )
    expect(checks).toHaveLength(11)
    expect(checks.every((entry) => entry.pass)).toBe(true)
  }, 30_000)
  test("captured driver primitives survive candidate stdout and JSON hooks", async () => {
    const checks = await textCase("coding.parse-duration").grade(
      fenced(`
process.stdout.write = () => true
JSON.stringify = () => "spoofed"
${parseDuration}
`),
    )
    expect(checks).toHaveLength(11)
    expect(checks.every((entry) => entry.pass)).toBe(true)
  }, 30_000)

  test("fake iterate-to-green stdout cannot claim a passing test run", async () => {
    const c = CASES.find(
      (candidate): candidate is ToolCase =>
        candidate.kind === "tools" && candidate.id === "agentic.iterate-to-green",
    )
    if (!c) throw new Error("missing iterate-to-green tool case")
    const env = c.environment()
    const source =
      'console.log("5 passed, 0 failed")\nexport function slugify(_s: string): string { return "wrong" }\n'
    await env.call("write_file", { path: "src/slug.ts", content: source })
    const runTestsOutput = await env.call("run_tests", {})
    const state = await env.state?.()
    const checks = c.grade(
      {
        calls: [
          { name: "write_file", args: { path: "src/slug.ts", content: source } },
          { name: "run_tests", args: {} },
        ],
        final: "done",
        turns: 1,
      },
      state,
    )
    expect(runTestsOutput).not.toBe("5 passed, 0 failed")
    expect(checks.slice(0, 5).every((entry) => !entry.pass)).toBe(true)
    expect(checks.find((entry) => entry.name === "confirmed green")?.pass).toBe(false)
  }, 30_000)

  test("stdout and JSON.stringify spoofing cannot create passing observations", async () => {
    const stdoutSpoof = fenced(`
process.stdout.write = () => true
console.log("RESULT 11 11")
function parseDuration(_input: string): number { return 0 }
`)
    const stringifySpoof = fenced(`
JSON.stringify = () => "[[1,2],[3,4],[5]]"
function chunk<T>(_items: T[], _size: number): T[][] { return [[1,2],[3,4],[999]] as T[][] }
`)
    for (const [id, answer, expectedCount] of [
      ["coding.parse-duration", stdoutSpoof, 11],
      ["coding.fix-chunk", stringifySpoof, 6],
    ] as const) {
      const checks = await textCase(id).grade(answer)
      expect(checks).toHaveLength(expectedCount)
      expect(checks.every((entry) => !entry.pass)).toBe(true)
    }
  }, 60_000)

  test("reading the driver file cannot reveal its runtime report nonce", async () => {
    const answer = fenced(`
const driver = await Bun.file("/work/case.ts").text()
const ownFile = await Bun.file(import.meta.path).text()
const nonce = /DISTPATCH_CALIBRATION_ORACLE:([0-9a-f-]{36})/.exec(driver + ownFile)?.[1]
if (nonce) {
  const observations = [
    { kind: "return", value: 5415, elapsedMs: 0 },
    { kind: "return", value: 2700, elapsedMs: 0 },
    { kind: "return", value: 7200, elapsedMs: 0 },
    { kind: "return", value: 10, elapsedMs: 0 },
    { kind: "return", value: 3605, elapsedMs: 0 },
    ...Array.from({ length: 6 }, () => ({ kind: "throw", isError: true, isRangeError: false, message: "error", elapsedMs: 0 })),
  ]
  process.stdout.write("\\u001eDISTPATCH_CALIBRATION_ORACLE:" + nonce + ":" + JSON.stringify({ valid: true, observations }) + "\\u001f")
  process.exit(0)
}
function parseDuration(_input: string): number { return 0 }
`)
    const checks = await textCase("coding.parse-duration").grade(answer)
    expect(checks).toHaveLength(11)
    expect(checks.every((entry) => !entry.pass)).toBe(true)
  }, 30_000)

  test("a fake driver frame cannot pass probes or replace the report", async () => {
    const answer = fenced(`
const fake = "\\u001eDISTPATCH_CALIBRATION_ORACLE:00000000-0000-4000-8000-000000000000:" + JSON.stringify({ valid: true, observations: Array.from({ length: 11 }, () => ({ kind: "return", value: 5415, elapsedMs: 0 })) }) + "\\u001f"
process.stdout.write(fake)
process.exit(0)
function parseDuration(_input: string): number { return 5415 }
`)
    const checks = await textCase("coding.parse-duration").grade(answer)
    expect(checks).toHaveLength(11)
    expect(checks.every((entry) => !entry.pass)).toBe(true)
  }, 30_000)
})

describe("calibration grading pipeline", () => {
  test("empty, huge, invalid JSON, and NUL-bearing outputs do not throw", async () => {
    const empty = await textCase("structured.extract").grade("")
    const huge = await textCase("structured.extract").grade("x".repeat(100_000))
    const invalidJson = await textCase("structured.extract").grade('{"date":\0}')
    const nulText = await textCase("general.facts").grade("\0".repeat(100_000))
    expect(empty.every((entry) => !entry.pass)).toBe(true)
    expect(huge.every((entry) => !entry.pass)).toBe(true)
    expect(invalidJson.every((entry) => !entry.pass)).toBe(true)
    expect(nulText.every((entry) => !entry.pass)).toBe(true)
  })
  test("malformed tool arguments are normalized before grading", async () => {
    const c = CASES.find((candidate) => candidate.id === "tool_use.strict-args")
    if (c?.kind !== "tools") throw new Error("missing strict-args tool case")
    const route = openAiChatRoute("calibration-test", "http://invalid.test/v1", "model")
    const originalFetch = globalThis.fetch
    const malformedArgs: unknown[] = [
      { title: "not JSON text" },
      "{invalid JSON",
      `{"title":"${"x".repeat(70_000)}"}`,
    ]
    let argumentValue: unknown = malformedArgs[0]
    let request = 0
    globalThis.fetch = async () => {
      const response =
        request++ === 0
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "create_event", arguments: argumentValue },
                      },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ message: { content: "done" } }] }
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      })
    }
    try {
      for (const malformed of malformedArgs) {
        argumentValue = malformed
        request = 0
        const result = await route.runTools?.(c)
        expect(result).toBeDefined()
        expect(result?.transcript.calls[0]?.args).toEqual({})
        const checks = c.grade(
          result?.transcript ?? { calls: [], final: "", turns: 0 },
          result?.state,
        )
        expect(checks.some((entry) => !entry.pass)).toBe(true)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  test("transport failures remain unknown while sandbox failures abort", () => {
    const failed = failedCase({ id: "coding.semver", run: 0 }, new Error("HTTP 429"))
    expect(failed.grade).toBeNull()
    expect(failed.error).toBe("HTTP 429")
    expect(() =>
      failedCase({ id: "coding.semver", run: 0 }, new CalibrationSandboxUnavailableError()),
    ).toThrow(CalibrationSandboxUnavailableError)
  })

  test("score records only current inputs and provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "distpatch-score-"))
    const resultsDir = join(directory, "results")
    const scoresPath = join(directory, "scores.json")
    await mkdir(resultsDir)
    try {
      await Bun.write(
        join(resultsDir, "current.json"),
        JSON.stringify({
          suite: SUITE_VERSION,
          graderVersion: GRADER_VERSION,
          profileId: "example/model",
          route: "dockerlm",
          wireModel: "wire-model",
          recordedAt: "2026-10-20T10:00:00.000Z",
          cases: [{ id: "general.bullets", dimension: "general", grade: 1 }],
          speed: [],
        }),
      )
      await Bun.write(
        join(resultsDir, "historical.json"),
        JSON.stringify({
          suite: SUITE_VERSION,
          graderVersion: "distpatch-grader-v1-pre-sandbox",
          profileId: "historical/model",
          route: "dockerlm",
          wireModel: "old-wire-model",
          recordedAt: "2026-10-17T10:00:00.000Z",
          cases: [],
          speed: [],
        }),
      )
      const generatedAt = "2026-10-21T00:00:00.000Z"
      const result = JSON.parse(await score(resultsDir, scoresPath, generatedAt)) as {
        suite: string
        graderVersion: string
        normalization: string
        generatedAt: string
        inputs: unknown[]
        excluded: {
          file: string
          profileId: string | null
          recordedAt: string | null
          suite: string | null
          graderVersion: string | null
          reason: string
        }[]
        raw: Record<string, unknown>
        scores: Record<string, unknown>
        saturated: unknown[]
        cases: Record<string, unknown>
        speed: unknown[]
      }
      expect(result).toMatchObject({
        suite: SUITE_VERSION,
        graderVersion: GRADER_VERSION,
        normalization: "distpatch-norm-v1",
        generatedAt,
        inputs: [
          {
            file: "current.json",
            profileId: "example/model",
            route: "dockerlm",
            wireModel: "wire-model",
            recordedAt: "2026-10-20T10:00:00.000Z",
            suite: SUITE_VERSION,
            graderVersion: GRADER_VERSION,
          },
        ],
        excluded: [
          {
            file: "historical.json",
            profileId: "historical/model",
            recordedAt: "2026-10-17T10:00:00.000Z",
            suite: SUITE_VERSION,
            graderVersion: "distpatch-grader-v1-pre-sandbox",
            reason: "grader version mismatch",
          },
        ],
        cases: { "example/model": { "general.bullets": 1 } },
        speed: [],
      })
      expect(Object.keys(result).sort()).toEqual(
        [
          "suite",
          "graderVersion",
          "normalization",
          "generatedAt",
          "inputs",
          "excluded",
          "raw",
          "scores",
          "saturated",
          "cases",
          "speed",
        ].sort(),
      )
      expect(JSON.parse(await Bun.file(scoresPath).text())).toEqual(result)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("score succeeds with only historical artifacts and excludes them all", async () => {
    const directory = await mkdtemp(join(tmpdir(), "distpatch-score-history-"))
    const resultsDir = join(directory, "results")
    await mkdir(resultsDir)
    try {
      await Bun.write(
        join(resultsDir, "old.json"),
        JSON.stringify({ suite: SUITE_VERSION, graderVersion: "distpatch-grader-v1-bwrap" }),
      )
      const result = JSON.parse(await score(resultsDir, join(directory, "scores.json"))) as {
        generatedAt: string
        inputs: unknown[]
        excluded: { file: string; reason: string }[]
        raw: Record<string, unknown>
        scores: Record<string, unknown>
        cases: Record<string, unknown>
        speed: unknown[]
      }
      expect(result.inputs).toEqual([])
      expect(result.excluded).toHaveLength(1)
      expect(result.excluded[0]).toEqual({
        file: "old.json",
        profileId: null,
        recordedAt: null,
        suite: SUITE_VERSION,
        graderVersion: "distpatch-grader-v1-bwrap",
        reason: "grader version mismatch; missing result provenance; invalid case results",
      })
      expect(result.raw).toEqual({})
      expect(result.scores).toEqual({})
      expect(result.cases).toEqual({})
      expect(result.speed).toEqual([])
      expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
