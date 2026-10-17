import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CASES,
  CalibrationSandboxUnavailableError,
  runBun,
  type TextCase,
} from "../../../bench/calibration/cases"

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url))
const README_PATH = join(REPO_ROOT, "README.md")

describe("local evaluation code-grading sandbox (Codex P2)", () => {
  test("1. cannot read a fake secret environment variable", async () => {
    const previous = process.env.FAKE_BENCHMARK_SECRET
    process.env.FAKE_BENCHMARK_SECRET = "super-secret-value-12345"
    try {
      const out = await runBun(
        'console.log("SECRET=" + (process.env.FAKE_BENCHMARK_SECRET ?? "ABSENT"))',
      )
      expect(out.trim()).toBe("SECRET=ABSENT")
      expect(out).not.toContain("super-secret-value-12345")
    } finally {
      if (previous === undefined) delete process.env.FAKE_BENCHMARK_SECRET
      else process.env.FAKE_BENCHMARK_SECRET = previous
    }
  })

  test("2. cannot read sensitive host environment values", async () => {
    const prevKey = process.env.OLLAMA_CLOUD_API_KEY
    const prevAa = process.env.AA_API_KEY
    const prevEnc = process.env.ENCRYPTION_KEY
    process.env.OLLAMA_CLOUD_API_KEY = "ollama-secret-token"
    process.env.AA_API_KEY = "aa-secret-token"
    process.env.ENCRYPTION_KEY = "encryption-secret-key"
    try {
      const out = await runBun("console.log(JSON.stringify(Object.keys(process.env).sort()))")
      const keys = JSON.parse(out.trim()) as string[]
      expect(keys).not.toContain("OLLAMA_CLOUD_API_KEY")
      expect(keys).not.toContain("AA_API_KEY")
      expect(keys).not.toContain("ENCRYPTION_KEY")
      expect(keys).not.toContain("DATABASE_URL")
      expect(keys).not.toContain("USER")
      expect(out).not.toContain("ollama-secret-token")
      expect(out).not.toContain("aa-secret-token")
      expect(out).not.toContain("encryption-secret-key")
    } finally {
      if (prevKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY
      else process.env.OLLAMA_CLOUD_API_KEY = prevKey
      if (prevAa === undefined) delete process.env.AA_API_KEY
      else process.env.AA_API_KEY = prevAa
      if (prevEnc === undefined) delete process.env.ENCRYPTION_KEY
      else process.env.ENCRYPTION_KEY = prevEnc
    }
  })

  test("3. cannot write to the repository", async () => {
    const target = join(REPO_ROOT, "sandbox-escape-probe.txt")
    const beforeReadme = readFileSync(README_PATH, "utf8")
    const out = await runBun(`
      import { writeFileSync } from "node:fs"
      let wroteRepo = false
      try {
        writeFileSync(${JSON.stringify(target)}, "pwned")
        wroteRepo = true
      } catch {}
      try {
        writeFileSync(${JSON.stringify(README_PATH)}, "pwned")
        wroteRepo = true
      } catch {}
      console.log("WROTE=" + wroteRepo)
    `)
    expect(out.trim()).toBe("WROTE=false")
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(README_PATH, "utf8")).toBe(beforeReadme)
  })

  test("4. cannot read arbitrary repository files or host /etc", async () => {
    const envPath = join(REPO_ROOT, ".env")
    const out = await runBun(`
      import { existsSync, readFileSync } from "node:fs"
      const results = {
        readme: existsSync(${JSON.stringify(README_PATH)}),
        dotenv: existsSync(${JSON.stringify(envPath)}),
        passwd: existsSync("/etc/passwd"),
      }
      let content = "NONE"
      try { content = readFileSync(${JSON.stringify(README_PATH)}, "utf8").slice(0, 20) } catch {}
      console.log(JSON.stringify({ results, content }))
    `)
    expect(JSON.parse(out.trim())).toEqual({
      results: { readme: false, dotenv: false, passwd: false },
      content: "NONE",
    })
  })

  test("5. cannot perform outbound HTTP or network access (including host loopback)", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("LOOPBACK_REACHED"),
    })
    try {
      const url = `http://127.0.0.1:${server.port}/`
      const out = await runBun(`
        let status = "BLOCKED"
        try {
          const res = await fetch(${JSON.stringify(url)})
          status = await res.text()
        } catch {
          status = "BLOCKED"
        }
        console.log(status)
      `)
      expect(out.trim()).toBe("BLOCKED")
    } finally {
      await server.stop(true)
    }
  })

  test("6. cannot escape the temporary grading area via parent traversal", async () => {
    const out = await runBun(`
      import { readdirSync } from "node:fs"
      import { resolve } from "node:path"
      const cwd = process.cwd()
      const parentEntries = readdirSync(resolve(cwd, "..")).sort()
      const canSeeHostHome = parentEntries.includes("home")
      console.log(JSON.stringify({ cwd, canSeeHostHome }))
    `)
    expect(JSON.parse(out.trim())).toEqual({
      cwd: "/work",
      canSeeHostHome: false,
    })
  })

  test("7. cannot run past the execution timeout, caps stdout before buffering, and aborts when bwrap is missing", async () => {
    const started = performance.now()
    const timedOut = await runBun('console.log("BEFORE"); while (true) {}', { timeoutMs: 300 })
    const elapsed = performance.now() - started
    expect(timedOut).toBe("")
    expect(elapsed).toBeLessThan(5_000)

    const floodOut = await runBun('while (true) { process.stdout.write("A".repeat(16384)) }', {
      maxStdoutBytes: 4096,
      timeoutMs: 5_000,
    })
    expect(floodOut).toBe("")

    await expect(runBun('console.log("SHOULD_NOT_RUN")', { bwrapPath: null })).rejects.toThrow(
      CalibrationSandboxUnavailableError,
    )
  })

  test("deterministic coding graders still pass inside the sandbox", async () => {
    const parseDurationCase = CASES.find((c) => c.id === "coding.parse-duration") as
      | TextCase
      | undefined
    if (!parseDurationCase) throw new Error("missing coding.parse-duration case")
    const checks = await parseDurationCase.grade(`\`\`\`ts
function parseDuration(input: string): number {
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(input)
  if (!m || (!m[1] && !m[2] && !m[3])) throw new Error("invalid")
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}
\`\`\``)
    expect(checks.length).toBe(11)
    expect(checks.every((c) => c.pass)).toBe(true)

    const spoofed = await parseDurationCase.grade(`\`\`\`ts
console.log("RESULT 11 11")
function parseDuration(_input: string): number {
  return 0
}
\`\`\``)
    expect(spoofed.length).toBe(11)
    expect(spoofed.every((c) => c.pass)).toBe(false)
  })
})
