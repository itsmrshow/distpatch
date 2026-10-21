import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { CASES, type Check, GRADER_VERSION, SPEED_PROMPT, SUITE_VERSION } from "./cases"
import { type ModelRun, NORMALIZATION_VERSION, normalize } from "./normalize"
import { claudeCliRoute, openAiChatRoute, type Route, type SpeedSample } from "./routes"
import { CalibrationSandboxUnavailableError } from "./sandbox"

/**
 * `bin/calibrate` — the Distpatch Local Evaluation Framework (evidence/capability-calibration-v1.md).
 *
 *   bin/calibrate run <route> <wire-model> <canonical-id> [--only <case-prefix>] [--speed-runs N]
 *   bin/calibrate score
 *
 * Supplemental evidence source for DockerLM/local models, custom quantizations, and Distpatch-
 * specific dimensions. Routes: `dockerlm` (DOCKERLM_BASE_URL), `ollama-cloud` (OLLAMA_CLOUD_API_KEY),
 * `claude-cli`. Results land in `evidence/capability-calibration-v1/results/<canonical-id>@<route>.json`;
 * no endpoint URL, header or credential is written. Never part of bin/check: it calls live models.
 */

const RESULTS = join(import.meta.dir, "../../../../evidence/capability-calibration-v1/results")
const ANSWER_LIMIT = 4_000

function route(name: string, model: string): Route {
  if (name === "dockerlm") {
    const url = process.env.DOCKERLM_BASE_URL
    if (!url) throw new Error("DOCKERLM_BASE_URL is not set")
    return openAiChatRoute(name, url, model)
  }
  if (name === "ollama-cloud") {
    const key = process.env.OLLAMA_CLOUD_API_KEY
    if (!key) throw new Error("OLLAMA_CLOUD_API_KEY is not set")
    return openAiChatRoute(name, "https://ollama.com/v1", model, key)
  }
  if (name === "claude-cli") return claudeCliRoute(model)
  throw new Error(`unknown route ${name}`)
}

const gradeOf = (checks: readonly Check[]) =>
  checks.length === 0 ? 0 : checks.filter((c) => c.pass).length / checks.length
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "unknown calibration error"
}

export function failedCase<T extends Record<string, unknown>>(base: T, error: unknown) {
  if (error instanceof CalibrationSandboxUnavailableError) throw error
  return { ...base, grade: null, error: errorMessage(error).slice(0, 200) }
}

function answerText(value: unknown): string {
  if (value === null || typeof value !== "object" || !("answer" in value)) return ""
  const answer = value.answer
  return typeof answer === "string" ? answer.slice(0, ANSWER_LIMIT) : ""
}

function latencyOf(value: unknown): number {
  if (value === null || typeof value !== "object" || !("latencyMs" in value)) return 0
  const latencyMs = value.latencyMs
  return typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.round(latencyMs) : 0
}

function transcriptOf(value: unknown): ToolTranscript {
  if (value === null || typeof value !== "object" || !("transcript" in value))
    return { calls: [], final: "", turns: 0 }
  const transcript = value.transcript
  if (
    transcript === null ||
    typeof transcript !== "object" ||
    !("calls" in transcript) ||
    !("final" in transcript) ||
    !("turns" in transcript)
  )
    return { calls: [], final: "", turns: 0 }
  const rawCalls = transcript.calls
  const calls = Array.isArray(rawCalls)
    ? rawCalls.map((call) => {
        if (call === null || typeof call !== "object" || !("name" in call) || !("args" in call))
          return { name: "", args: {} }
        const args =
          call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {}
        return { name: typeof call.name === "string" ? call.name : "", args }
      })
    : []
  return {
    calls,
    final: typeof transcript.final === "string" ? transcript.final.slice(0, ANSWER_LIMIT) : "",
    turns:
      typeof transcript.turns === "number" && Number.isFinite(transcript.turns)
        ? transcript.turns
        : 0,
  }
}

async function run(
  routeName: string,
  model: string,
  profileId: string,
  only: string,
  speedRuns: number,
  repeat: number,
) {
  const r = route(routeName, model)
  const cases: { readonly grade: number | null; readonly [field: string]: unknown }[] = []
  const transportErrors: string[] = []
  const selected = CASES.filter((x) => x.id.startsWith(only))
  for (let rep = 0; rep < repeat; rep++) {
    for (const c of selected) {
      process.stderr.write(`[${rep}] ${c.id} … `)
      const base = { id: c.id, dimension: c.dimension, run: rep }
      if (c.kind === "tools" && (!r.tools || r.runTools === undefined)) {
        cases.push({ ...base, grade: null, skipped: "route has no caller-defined tools" })
        process.stderr.write("skipped\n")
        continue
      }
      try {
        if (c.kind === "text") {
          const reply = await r.text(c.prompt)
          const answer = answerText(reply)
          const checks = await c.grade(answer)
          cases.push({
            ...base,
            grade: gradeOf(checks),
            checks,
            latencyMs: latencyOf(reply),
            answer,
          })
        } else {
          const out = await (r.runTools as NonNullable<Route["runTools"]>)(c)
          const transcript = transcriptOf(out)
          const state = typeof out === "object" && out !== null && "state" in out ? out.state : null
          const checks = c.grade(transcript, state)
          cases.push({
            ...base,
            grade: gradeOf(checks),
            checks,
            latencyMs: latencyOf(out),
            transcript,
            state,
          })
        }
      } catch (error) {
        const failure = failedCase(base, error)
        cases.push(failure)
        transportErrors.push(`${c.id} run ${rep}: ${String(failure.error)}`)
      }
      process.stderr.write(`${cases.at(-1)?.grade}\n`)
    }
  }

  const speed: SpeedSample[] = []
  if (r.speed !== undefined) {
    try {
      await r.speed(SPEED_PROMPT) // warm-up (model load), discarded
      for (let i = 0; i < speedRuns; i++) speed.push(await r.speed(SPEED_PROMPT))
    } catch (error) {
      if (error instanceof CalibrationSandboxUnavailableError) throw error
      transportErrors.push(`speed: ${errorMessage(error).slice(0, 200)}`)
    }
  }
  process.stderr.write(`run summary: ${transportErrors.length} transport error(s)\n`)
  for (const error of transportErrors) process.stderr.write(`  ${error}\n`)

  await mkdir(RESULTS, { recursive: true })
  const file = join(
    RESULTS,
    `${profileId.replace("/", "__")}@${routeName}${only ? `.${only}` : ""}.json`,
  )
  await Bun.write(
    file,
    `${JSON.stringify(
      {
        suite: SUITE_VERSION,
        graderVersion: GRADER_VERSION,
        profileId,
        semanticModelId: profileId,
        route: routeName,
        routeId: routeName,
        runtime: r.runtime,
        settings: r.settings,
        wireModel: model,
        recordedAt: new Date().toISOString(),
        cases,
        speed: speed.map((s) => ({
          ttftMs: Math.round(s.ttftMs),
          wallMs: Math.round(s.wallMs),
          outputTokens: s.outputTokens,
        })),
      },
      null,
      2,
    )}\n`,
  )
  process.stderr.write(`wrote ${file}\n`)
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length === 0
    ? null
    : s.length % 2
      ? (s[m] as number)
      : ((s[m - 1] as number) + (s[m] as number)) / 2
}

function isGradedCase(value: unknown): value is ModelRun["cases"][number] {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    !("grade" in value)
  )
    return false
  const grade = value.grade
  return (
    typeof value.id === "string" &&
    (grade === null ||
      (typeof grade === "number" && Number.isFinite(grade) && grade >= 0 && grade <= 1))
  )
}

function isSpeedSample(value: unknown): value is SpeedSample {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("ttftMs" in value) ||
    !("wallMs" in value) ||
    !("outputTokens" in value)
  )
    return false
  return (
    typeof value.ttftMs === "number" &&
    Number.isFinite(value.ttftMs) &&
    typeof value.wallMs === "number" &&
    Number.isFinite(value.wallMs) &&
    (value.outputTokens === null ||
      (typeof value.outputTokens === "number" && Number.isFinite(value.outputTokens)))
  )
}

/** Normalizes only current-version results and records every included/excluded input. */
export async function score(
  resultsDir = RESULTS,
  scoresPath = join(resultsDir, "../scores.json"),
  generatedAt = new Date().toISOString(),
): Promise<string> {
  type ScoreRun = ModelRun & {
    route: string
    wireModel: string
    recordedAt: string
    graderVersion: string
    speed: SpeedSample[]
  }
  const runs: ScoreRun[] = []
  const inputs: {
    file: string
    profileId: string
    route: string
    wireModel: string
    recordedAt: string
    suite: string
    graderVersion: string
  }[] = []
  const excluded: {
    file: string
    profileId: string | null
    recordedAt: string | null
    suite: string | null
    graderVersion: string | null
    reason: string
  }[] = []

  for (const name of (await readdir(resultsDir)).filter((file) => file.endsWith(".json")).sort()) {
    let artifact: unknown
    let invalidJson = false
    try {
      artifact = await Bun.file(join(resultsDir, name)).json()
    } catch {
      invalidJson = true
    }
    const result =
      artifact !== null && typeof artifact === "object" && !Array.isArray(artifact)
        ? artifact
        : null
    const suiteValue = result !== null && "suite" in result ? result.suite : undefined
    const graderVersionValue =
      result !== null && "graderVersion" in result ? result.graderVersion : undefined
    const profileIdValue = result !== null && "profileId" in result ? result.profileId : undefined
    const routeValue = result !== null && "route" in result ? result.route : undefined
    const wireModelValue = result !== null && "wireModel" in result ? result.wireModel : undefined
    const recordedAtValue =
      result !== null && "recordedAt" in result ? result.recordedAt : undefined
    const caseValues = result !== null && "cases" in result ? result.cases : undefined
    const speedValue = result !== null && "speed" in result ? result.speed : undefined
    const suite = typeof suiteValue === "string" ? suiteValue : null
    const graderVersion = typeof graderVersionValue === "string" ? graderVersionValue : null
    const profileId = typeof profileIdValue === "string" ? profileIdValue : null
    const routeName = typeof routeValue === "string" ? routeValue : null
    const wireModel = typeof wireModelValue === "string" ? wireModelValue : null
    const recordedAt = typeof recordedAtValue === "string" ? recordedAtValue : null
    const reasons: string[] = []
    if (invalidJson) reasons.push("invalid JSON")
    if (suiteValue !== SUITE_VERSION) reasons.push("suite version mismatch")
    if (graderVersionValue !== GRADER_VERSION) reasons.push("grader version mismatch")
    if (result === null) reasons.push("result must be a JSON object")
    if (profileId === null || routeName === null || wireModel === null || recordedAt === null)
      reasons.push("missing result provenance")
    if (!Array.isArray(caseValues) || !caseValues.every(isGradedCase))
      reasons.push("invalid case results")
    let speedSamples: SpeedSample[] = []
    if (speedValue !== undefined) {
      if (Array.isArray(speedValue) && speedValue.every(isSpeedSample)) speedSamples = speedValue
      else reasons.push("invalid speed results")
    }
    if (reasons.length > 0) {
      excluded.push({
        file: name,
        profileId,
        recordedAt,
        suite,
        graderVersion,
        reason: reasons.join("; "),
      })
      continue
    }

    const cases = caseValues as ModelRun["cases"]
    const run: ScoreRun = {
      profileId: profileId as string,
      suite: suite as string,
      cases,
      route: routeName as string,
      wireModel: wireModel as string,
      recordedAt: recordedAt as string,
      graderVersion: graderVersion as string,
      speed: speedSamples,
    }
    runs.push(run)
    inputs.push({
      file: name,
      profileId: run.profileId,
      route: run.route,
      wireModel: run.wireModel,
      recordedAt: run.recordedAt,
      suite: run.suite,
      graderVersion: run.graderVersion,
    })
  }

  const normalized = normalize(runs, CASES, SUITE_VERSION)
  const cases: Record<string, Record<string, number | null>> = {}
  for (const run of runs) {
    for (const c of CASES) {
      const grades = run.cases
        .filter((graded) => graded.id === c.id && graded.grade !== null)
        .map((graded) => graded.grade as number)
      if (grades.length === 0) continue
      cases[run.profileId] ??= {}
      ;(cases[run.profileId] as Record<string, number | null>)[c.id] =
        Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 1000) / 1000
    }
  }
  // Route-bound observations, never scores: see the evidence artifact.
  const speed = runs
    .filter((run) => run.speed.length > 0)
    .map((run) => {
      const samples = run.speed
      const rates = samples
        .filter((sample) => sample.outputTokens !== null && sample.wallMs > sample.ttftMs)
        .map((sample) => ((sample.outputTokens as number) * 1000) / (sample.wallMs - sample.ttftMs))
      return {
        profileId: run.profileId,
        route: run.route,
        samples: samples.length,
        medianTtftMs: median(samples.map((sample) => sample.ttftMs)),
        medianWallMs: median(samples.map((sample) => sample.wallMs)),
        medianOutputTokensPerSecond:
          median(rates) === null ? null : Math.round(median(rates) as number),
      }
    })
  const body = `${JSON.stringify(
    {
      suite: SUITE_VERSION,
      graderVersion: GRADER_VERSION,
      normalization: NORMALIZATION_VERSION,
      generatedAt,
      inputs,
      excluded,
      ...normalized,
      cases,
      speed,
    },
    null,
    2,
  )}\n`
  await Bun.write(scoresPath, body)
  return body
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(name)
    return i === -1 ? fallback : (args[i + 1] ?? fallback)
  }
  if (command === "run" && args.length >= 3) {
    await run(
      args[0] as string,
      args[1] as string,
      args[2] as string,
      flag("--only", ""),
      Number(flag("--speed-runs", "5")),
      Number(flag("--repeat", "2")),
    )
  } else if (command === "score") {
    process.stdout.write(await score())
  } else {
    process.stderr.write(
      "usage: bin/calibrate run <dockerlm|ollama-cloud|claude-cli> <wire-model> <canonical-id> [--only prefix] [--speed-runs N]\n       bin/calibrate score\n",
    )
    process.exit(64)
  }
}
