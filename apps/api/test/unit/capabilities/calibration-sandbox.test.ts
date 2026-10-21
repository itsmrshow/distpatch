import { describe, expect, spyOn, test } from "bun:test"
import fs, { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CASES, type TextCase } from "../../../bench/calibration/cases"
import { CalibrationSandboxUnavailableError, runBun } from "../../../bench/calibration/sandbox"
import { calibrationSandboxSkipped } from "../../support/calibration-sandbox-gate"

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url))
const README_PATH = join(REPO_ROOT, "README.md")
const PTRACE_SCOPE_PATH = "/proc/sys/kernel/yama/ptrace_scope"
const sandboxSkipped = await calibrationSandboxSkipped(
  "apps/api/test/unit/capabilities/calibration-sandbox.test.ts",
)

function hasDetachedProbe(): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || entry === String(process.pid)) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes("37.4242")) return true
    } catch {
      // Processes can exit between reading the proc directory and their cmdline.
    }
  }
  return false
}

async function expectNoDetachedProbe(): Promise<void> {
  // Wait briefly for kernel process-table cleanup after cgroup.kill, not for application timing.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!hasDetachedProbe()) return
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 50)
    await delay.promise
  }
}

describe.skipIf(sandboxSkipped)("local evaluation code-grading sandbox (Codex P2)", () => {
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

  test("2. scrubs host secrets and starts without session environment variables", async () => {
    const prevKey = process.env.OLLAMA_CLOUD_API_KEY
    const prevAa = process.env.AA_API_KEY
    const prevEnc = process.env.ENCRYPTION_KEY
    const prevPath = process.env.PATH
    const prevXdg = process.env.XDG_RUNTIME_DIR
    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS
    process.env.OLLAMA_CLOUD_API_KEY = "ollama-secret-token"
    process.env.AA_API_KEY = "aa-secret-token"
    process.env.ENCRYPTION_KEY = "encryption-secret-key"
    try {
      delete process.env.PATH
      delete process.env.XDG_RUNTIME_DIR
      delete process.env.DBUS_SESSION_BUS_ADDRESS
      const out = await runBun("console.log(JSON.stringify(Object.keys(process.env).sort()))")
      const keys = JSON.parse(out.trim()) as string[]
      for (const forbidden of [
        "OLLAMA_CLOUD_API_KEY",
        "AA_API_KEY",
        "ENCRYPTION_KEY",
        "DATABASE_URL",
        "USER",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        expect(keys).not.toContain(forbidden)
      }
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
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
      if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = prevXdg
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus
    }
  })

  test("3. confines ordinary file writes to tmpfs and cannot modify input or host files", async () => {
    const target = join(REPO_ROOT, "sandbox-escape-probe.txt")
    const beforeReadme = readFileSync(README_PATH, "utf8")
    const out = await runBun(`
      import { existsSync, statfsSync, unlinkSync, writeFileSync } from "node:fs"
      function canWrite(path: string): boolean {
        try {
          writeFileSync(path, "probe")
          unlinkSync(path)
          return true
        } catch {
          return false
        }
      }
      let devNullWritable = false
      try {
        writeFileSync("/dev/null", "probe")
        devNullWritable = true
      } catch {}
      console.log(JSON.stringify({
        workReadable: existsSync("/work/case.ts"),
        workWritable: canWrite("/work/sandbox-write-probe"),
        tmpWritable: canWrite("/tmp/sandbox-write-probe"),
        tmpIsTmpfs: statfsSync("/tmp").type === 0x01021994,
        rootWritable: canWrite("/sandbox-root-write-probe"),
        devWritable: canWrite("/dev/sandbox-dev-write-probe"),
        devNullWritable,
        shmWritable: canWrite("/dev/shm/sandbox-shm-write-probe"),
      }))
    `)
    expect(JSON.parse(out.trim())).toEqual({
      workReadable: true,
      workWritable: false,
      tmpWritable: true,
      tmpIsTmpfs: true,
      rootWritable: false,
      devWritable: false,
      devNullWritable: true,
      shmWritable: false,
    })
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

  test("7. applies dash resource limits and bounds aggregate memory and process creation", async () => {
    const limits = await runBun(
      `
        const shell = Bun.spawnSync(
          ["/bin/sh", "-c", "printf 'CPU='; ulimit -t; printf 'VMEM='; ulimit -v; printf 'FILE='; ulimit -f; printf 'CORE='; ulimit -c"],
          { stdout: "pipe", stderr: "pipe" },
        )
        console.log(new TextDecoder().decode(shell.stdout ?? new Uint8Array()).trim())
      `,
      { timeoutMs: 5_000 },
    )
    expect(limits).toContain("CPU=5")
    expect(limits).toContain("VMEM=2097152")
    expect(limits).toContain("FILE=8192")
    expect(limits).toContain("CORE=0")

    const memoryStarted = performance.now()
    const memoryBomb = await runBun(
      'const memory = new Uint8Array(512 * 1024 * 1024); memory.fill(1); console.log("ALLOCATED")',
      { timeoutMs: 5_000 },
    )
    expect(memoryBomb).toBe("")
    expect(performance.now() - memoryStarted).toBeLessThan(5_000)

    const forkStarted = performance.now()
    const forkBomb = await runBun(
      `
        const children = []
        let blocked = false
        for (let i = 0; i < 128; i++) {
          try {
            children.push(Bun.spawn(["/usr/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" }))
          } catch {
            blocked = true
            break
          }
        }
        for (const child of children) child.kill("SIGKILL")
        await Promise.all(children.map((child) => child.exited))
        console.log(JSON.stringify({ blocked, count: children.length }))
      `,
      { timeoutMs: 5_000 },
    )
    const forkResult = JSON.parse(forkBomb) as { blocked: boolean; count: number }
    expect(forkResult.blocked).toBe(true)
    expect(forkResult.count).toBeLessThan(64)
    expect(performance.now() - forkStarted).toBeLessThan(5_000)
  })

  test("8. kills every descendant on timeout and stdout overflow, bounds stderr, and fails closed on setup errors", async () => {
    const timeoutStarted = performance.now()
    const timedOut = await runBun(
      'Bun.spawn(["/usr/bin/setsid", "/usr/bin/sleep", "37.4242"], { stdout: "ignore", stderr: "ignore" }); while (true) {}',
      { timeoutMs: 300 },
    )
    expect(timedOut).toBe("")
    expect(performance.now() - timeoutStarted).toBeLessThan(5_000)
    await expectNoDetachedProbe()
    expect(hasDetachedProbe()).toBe(false)

    const overflowStarted = performance.now()
    const floodOut = await runBun(
      'Bun.spawn(["/usr/bin/setsid", "/usr/bin/sleep", "37.4242"], { stdout: "ignore", stderr: "ignore" }); process.stdout.write("A".repeat(16384)); while (true) {}',
      { maxStdoutBytes: 4096, timeoutMs: 5_000 },
    )
    expect(floodOut).toBe("")
    expect(performance.now() - overflowStarted).toBeLessThan(4_000)
    await expectNoDetachedProbe()
    expect(hasDetachedProbe()).toBe(false)

    const stderrStarted = performance.now()
    const floodErr = await runBun('while (true) process.stderr.write("E".repeat(16384))', {
      timeoutMs: 5_000,
    })
    expect(floodErr).toBe("")
    expect(performance.now() - stderrStarted).toBeLessThan(4_000)

    await expect(
      runBun('console.log("SHOULD_NOT_RUN")', { bwrapPath: "/nonexistent/distpatch-bwrap" }),
    ).rejects.toThrow(CalibrationSandboxUnavailableError)
    await expect(runBun('console.log("SHOULD_NOT_RUN")', { bwrapPath: null })).rejects.toThrow(
      CalibrationSandboxUnavailableError,
    )

    // Warm the cached preflight, then make the staged interpreter non-executable. Readiness must
    // come from that interpreter, not from the shell that prepares its resource limits.
    const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")
    if (!execPathDescriptor) throw new Error("process.execPath is not configurable in this runtime")
    expect(await runBun('console.log("PREWARMED")')).toBe("PREWARMED\n")
    try {
      Object.defineProperty(process, "execPath", { ...execPathDescriptor, value: README_PATH })
      await expect(runBun('console.log("SHOULD_NOT_RUN")')).rejects.toThrow(
        CalibrationSandboxUnavailableError,
      )
    } finally {
      Object.defineProperty(process, "execPath", execPathDescriptor)
    }
  })
  test("9. fails closed unless host Yama ptrace_scope is 1, 2, or 3", async () => {
    // Invariant: the untrusted candidate process must never obtain PTRACE_MODE_ATTACH on the
    // trusted driver or sandbox launcher.
    const originalReadFileSync = fs.readFileSync
    let ptraceScope: string | Error = "1"
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      path: unknown,
      ...args: unknown[]
    ) => {
      if (String(path) === PTRACE_SCOPE_PATH) {
        if (ptraceScope instanceof Error) throw ptraceScope
        return ptraceScope
      }
      return originalReadFileSync(path as never, ...(args as never[]))
    }) as unknown as typeof fs.readFileSync)
    try {
      for (const scope of ["0", "4", "x1", ""]) {
        ptraceScope = scope
        await expect(runBun('console.log("UNTRUSTED_MUST_NOT_RUN")')).rejects.toBeInstanceOf(
          CalibrationSandboxUnavailableError,
        )
      }
      for (const code of ["ENOENT", "EACCES"]) {
        ptraceScope = Object.assign(new Error("stubbed ptrace_scope read failure"), { code })
        await expect(runBun('console.log("UNTRUSTED_MUST_NOT_RUN")')).rejects.toBeInstanceOf(
          CalibrationSandboxUnavailableError,
        )
      }
      for (const scope of ["1", "2", "3"]) {
        ptraceScope = `${scope}\n`
        expect(await runBun('console.log("PTRACESCOPE_OK")')).toBe("PTRACESCOPE_OK\n")
      }
    } finally {
      readSpy.mockRestore()
    }
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
