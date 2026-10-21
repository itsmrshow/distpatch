import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Runs calibration code in bubblewrap's private namespaces with no network, a scrubbed environment,
 * read-only system/input/dev mounts; ordinary file writes are confined to a writable `/tmp` tmpfs.
 * A systemd user-scope cgroup caps the whole tree at 256 MiB memory, zero swap, 64 tasks, and one CPU.
 * Dash also applies per-process CPU-time limits rounded up from the deadline, 2 GiB address space,
 * and zero core dumps. stdout and stderr are capped at 64 KiB by default; timeout or stream
 * overflow kills the whole scope. A cached preflight verifies sandbox execution and cgroup limits;
 * any unestablished guarantee aborts with {@link CalibrationSandboxUnavailableError}.
 */
export class CalibrationSandboxUnavailableError extends Error {
  constructor(
    message = "calibration sandbox requires bubblewrap, a systemd user scope, and delegated cgroup limits",
  ) {
    super(message)
    this.name = "CalibrationSandboxUnavailableError"
  }
}

export interface RunBunOptions {
  readonly timeoutMs?: number
  readonly maxStdoutBytes?: number
  readonly bwrapPath?: string | null
  readonly reportNonce?: string
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 10_000
const MAX_STDOUT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MEMORY_MAX_BYTES = 256 * 1024 * 1024
const MEMORY_MAX_SETTING = "256M"
const TASKS_MAX = 64
const CPU_QUOTA_SETTING = "100%"
const READY_TOKEN = "__DISTPATCH_CALIBRATION_SANDBOX_READY_91E43B__"
const PREFLIGHT_OUTPUT = "__DISTPATCH_CALIBRATION_SANDBOX_PREFLIGHT_OK__"
const PREFLIGHT_SOURCE = `console.log(${JSON.stringify(PREFLIGHT_OUTPUT)}); const delay = Promise.withResolvers<void>(); setTimeout(delay.resolve, 250); await delay.promise`

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onExceed: () => void,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        total = maxBytes
        onExceed()
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    // Stream closed early after kill/cancel.
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function scopeCgroupPath(pid: number): string {
  const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("0::"))
  if (!line) throw new Error("the sandbox process has no cgroup-v2 membership")
  const relativePath = line.slice(3)
  if (!relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("the sandbox process has an invalid cgroup-v2 path")
  }
  return join("/sys/fs/cgroup", relativePath.slice(1))
}

function verifyScopeLimits(pid: number): string {
  const directory = scopeCgroupPath(pid)
  const memoryMax = readFileSync(join(directory, "memory.max"), "utf8").trim()
  const memorySwapMax = readFileSync(join(directory, "memory.swap.max"), "utf8").trim()
  const tasksMax = readFileSync(join(directory, "pids.max"), "utf8").trim()
  const [cpuQuota, cpuPeriod] = readFileSync(join(directory, "cpu.max"), "utf8")
    .trim()
    .split(/\s+/)
    .map(Number)
  if (
    memoryMax !== String(MEMORY_MAX_BYTES) ||
    memorySwapMax !== "0" ||
    tasksMax !== String(TASKS_MAX) ||
    !Number.isFinite(cpuQuota) ||
    !Number.isFinite(cpuPeriod) ||
    cpuQuota <= 0 ||
    cpuQuota !== cpuPeriod
  ) {
    throw new Error("the sandbox cgroup resource limits are not in effect")
  }
  accessSync(join(directory, "cgroup.kill"), constants.W_OK)
  return directory
}

async function waitForScopeLimits(pid: number, processExited: () => boolean): Promise<string> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (!processExited() && Date.now() < deadline) {
    try {
      return verifyScopeLimits(pid)
    } catch (error) {
      lastError = error
    }
    const retry = Promise.withResolvers<void>()
    setTimeout(retry.resolve, 10)
    await retry.promise
  }
  throw lastError instanceof Error ? lastError : new Error("the systemd scope did not start")
}

function killScope(cgroupDirectory: string | undefined, killMainProcess: () => void): void {
  if (cgroupDirectory) {
    try {
      writeFileSync(join(cgroupDirectory, "cgroup.kill"), "1")
      return
    } catch {
      // Fall back to killing the scope's main process if cgroup cleanup is unavailable.
    }
  }
  killMainProcess()
}

function systemdEnvironment(): Record<string, string> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new CalibrationSandboxUnavailableError("calibration sandbox requires a Unix user id")
  }
  return {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
      ? {}
      : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
  }
}

async function executeSandbox(
  source: string,
  options: RunBunOptions,
  bwrap: string,
  systemdRun: string,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_STDOUT_BYTES
  const cpuSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
  let dir: string
  try {
    dir = await mkdtemp(join(tmpdir(), "distpatch-cal-"))
  } catch {
    throw new CalibrationSandboxUnavailableError(
      "could not create the calibration sandbox input area",
    )
  }
  try {
    const file = join(dir, "case.ts")
    try {
      await Bun.write(file, source)
    } catch {
      throw new CalibrationSandboxUnavailableError("could not stage the calibration sandbox input")
    }
    const mounts = ["/usr", "/lib", "/lib64", "/bin", "/sbin"].flatMap((p) =>
      existsSync(p) ? ["--ro-bind", p, p] : [],
    )
    const proc = (() => {
      try {
        return Bun.spawn(
          [
            systemdRun,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--property=MemoryMax=${MEMORY_MAX_SETTING}`,
            "--property=MemorySwapMax=0",
            `--property=TasksMax=${TASKS_MAX}`,
            `--property=CPUQuota=${CPU_QUOTA_SETTING}`,
            "--",
            "/bin/sh",
            "-c",
            'IFS= read -r launch || exit 98; [ "$launch" = "start-calibration" ] || exit 98; exec "$@"',
            "distpatch-sandbox-launcher",
            bwrap,
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--clearenv",
            "--setenv",
            "PATH",
            "/opt/bin:/usr/bin:/bin",
            "--setenv",
            "HOME",
            "/tmp",
            "--setenv",
            "TMPDIR",
            "/tmp",
            "--setenv",
            "BUN_INSTALL",
            "/tmp/bun",
            "--setenv",
            "DO_NOT_TRACK",
            "1",
            ...mounts,
            "--dir",
            "/opt/bin",
            "--ro-bind",
            process.execPath,
            "/opt/bin/bun",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
            dir,
            "/work",
            "--remount-ro",
            "/dev/pts",
            "--remount-ro",
            "/dev",
            "--remount-ro",
            "/",
            "--chdir",
            "/work",
            "/bin/sh",
            "-c",
            // dash requires each limit separately; readiness is emitted only after every setting
            // succeeded and immediately before exec, so setup failures cannot become model failures.
            `ulimit -t ${cpuSeconds} || exit 97; ulimit -v 2097152 || exit 97; ulimit -f 8192 || exit 97; ulimit -c 0 || exit 97; printf '%s\\n' '${READY_TOKEN}' >&2 || exit 97; exec /opt/bin/bun /work/case.ts`,
          ],
          {
            cwd: dir,
            env: systemdEnvironment(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
      } catch {
        throw new CalibrationSandboxUnavailableError(
          "could not start the systemd calibration scope",
        )
      }
    })()

    let processExited = false
    const exitPromise = proc.exited.then((status: number) => {
      processExited = true
      return status
    })
    let cgroupDirectory: string | undefined
    const killProc = () =>
      killScope(cgroupDirectory, () => {
        try {
          proc.kill("SIGKILL")
        } catch {}
      })
    let timedOut = false
    let overflowed = false
    const timer = setTimeout(() => {
      timedOut = true
      killProc()
    }, timeoutMs)
    try {
      try {
        // The launcher waits on stdin so limits can be confirmed before it starts bwrap.
        cgroupDirectory = await waitForScopeLimits(proc.pid, () => processExited)
        if (!proc.stdin) throw new Error("the systemd scope launcher has no input pipe")
        proc.stdin.write("start-calibration\n")
        if (options.reportNonce !== undefined) proc.stdin.write(`${options.reportNonce}\n`)
        proc.stdin.end()
      } catch {
        killProc()
        await exitPromise.catch(() => -1)
        throw new CalibrationSandboxUnavailableError(
          "the systemd calibration scope did not establish its required cgroup limits",
        )
      }
      const [stdoutBytes, stderrBytes] = await Promise.all([
        readBoundedStream(proc.stdout, maxStdoutBytes, () => {
          overflowed = true
          killProc()
        }),
        readBoundedStream(proc.stderr, MAX_STDERR_BYTES, () => {
          overflowed = true
          killProc()
        }),
        exitPromise,
      ])
      if (!new TextDecoder().decode(stderrBytes).includes(READY_TOKEN)) {
        throw new CalibrationSandboxUnavailableError(
          "the calibration sandbox did not complete its required setup",
        )
      }
      if (timedOut || overflowed) return ""
      return new TextDecoder().decode(stdoutBytes)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

let preflightPromise: Promise<void> | undefined

function ensureSandboxPreflight(bwrap: string, systemdRun: string): Promise<void> {
  if (!preflightPromise) {
    preflightPromise = (async () => {
      const output = await executeSandbox(PREFLIGHT_SOURCE, {}, bwrap, systemdRun)
      if (output.trim() !== PREFLIGHT_OUTPUT) {
        throw new CalibrationSandboxUnavailableError(
          "the calibration sandbox preflight did not execute its probe successfully",
        )
      }
    })()
  }
  return preflightPromise
}

/**
 * Runs `source` in the preflighted calibration sandbox and returns its stdout. Setup failures throw
 * {@link CalibrationSandboxUnavailableError}, allowing callers to abort instead of grading a
 * harness failure as a model failure.
 */
export async function runBun(source: string, options: RunBunOptions = {}): Promise<string> {
  const bwrap = options.bwrapPath === undefined ? Bun.which("bwrap") : options.bwrapPath
  const systemdRun = Bun.which("systemd-run")
  if (!bwrap || !systemdRun) throw new CalibrationSandboxUnavailableError()
  await ensureSandboxPreflight(bwrap, systemdRun)
  return executeSandbox(source, options, bwrap, systemdRun)
}
