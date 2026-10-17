import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  CASES,
  CalibrationSandboxUnavailableError,
  type Check,
  GRADER_VERSION,
  SPEED_PROMPT,
  SUITE_VERSION,
} from "./cases"
import { type ModelRun, NORMALIZATION_VERSION, normalize } from "./normalize"
import { claudeCliRoute, openAiChatRoute, type Route, type SpeedSample } from "./routes"

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
          const checks = await c.grade(reply.answer)
          cases.push({
            ...base,
            grade: gradeOf(checks),
            checks,
            latencyMs: Math.round(reply.latencyMs),
            answer: reply.answer.slice(0, ANSWER_LIMIT),
          })
        } else {
          const out = await (r.runTools as NonNullable<Route["runTools"]>)(c)
          const checks = c.grade(out.transcript, out.state)
          cases.push({
            ...base,
            grade: gradeOf(checks),
            checks,
            latencyMs: Math.round(out.latencyMs),
            transcript: { ...out.transcript, final: out.transcript.final.slice(0, ANSWER_LIMIT) },
            state: out.state,
          })
        }
      } catch (error) {
        if (error instanceof CalibrationSandboxUnavailableError) throw error
        // A transport failure is a failed case: an endpoint that cannot answer has not shown skill.
        cases.push({ ...base, grade: 0, error: (error as Error).message.slice(0, 200) })
      }
      process.stderr.write(`${cases.at(-1)?.grade}\n`)
    }
  }

  const speed: SpeedSample[] = []
  if (r.speed !== undefined) {
    await r.speed(SPEED_PROMPT) // warm-up (model load), discarded
    for (let i = 0; i < speedRuns; i++) speed.push(await r.speed(SPEED_PROMPT))
  }

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

/** Normalizes every result file and writes `scores.json` beside them (also printed). */
async function score() {
  const runs: (ModelRun & { route: string; graderVersion?: string; speed?: SpeedSample[] })[] = []
  for (const name of (await readdir(RESULTS)).filter((n) => n.endsWith(".json")).sort()) {
    const run = await Bun.file(join(RESULTS, name)).json()
    if (run.graderVersion !== GRADER_VERSION) {
      throw new Error(
        `${name}: grader version ${String(run.graderVersion ?? "(missing)")} does not match the current grader ${GRADER_VERSION}; re-run the model with \`bin/calibrate run <route> <wire-model> <canonical-id>\` rather than mixing grader versions`,
      )
    }
    runs.push(run)
  }
  const normalized = normalize(runs, CASES, SUITE_VERSION)
  const cases: Record<string, Record<string, number | null>> = {}
  for (const run of runs) {
    for (const c of CASES) {
      const grades = run.cases
        .filter((g) => g.id === c.id && g.grade !== null)
        .map((g) => g.grade as number)
      if (grades.length === 0) continue
      cases[run.profileId] ??= {}
      ;(cases[run.profileId] as Record<string, number | null>)[c.id] =
        Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 1000) / 1000
    }
  }
  // Route-bound observations, never scores: see the evidence artifact.
  const speed = runs
    .filter((r) => (r.speed ?? []).length > 0)
    .map((r) => {
      const samples = r.speed as SpeedSample[]
      const rates = samples
        .filter((s) => s.outputTokens !== null && s.wallMs > s.ttftMs)
        .map((s) => ((s.outputTokens as number) * 1000) / (s.wallMs - s.ttftMs))
      return {
        profileId: r.profileId,
        route: r.route,
        samples: samples.length,
        medianTtftMs: median(samples.map((s) => s.ttftMs)),
        medianWallMs: median(samples.map((s) => s.wallMs)),
        medianOutputTokensPerSecond:
          median(rates) === null ? null : Math.round(median(rates) as number),
      }
    })
  const body = `${JSON.stringify(
    { suite: SUITE_VERSION, normalization: NORMALIZATION_VERSION, ...normalized, cases, speed },
    null,
    2,
  )}\n`
  await Bun.write(join(RESULTS, "../scores.json"), body)
  process.stdout.write(body)
}

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
  await score()
} else {
  process.stderr.write(
    "usage: bin/calibrate run <dockerlm|ollama-cloud|claude-cli> <wire-model> <canonical-id> [--only prefix] [--speed-runs N]\n       bin/calibrate score\n",
  )
  process.exit(64)
}
