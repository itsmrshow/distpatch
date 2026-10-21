import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The calibration sandbox: executes model-generated TypeScript under bubblewrap. Model output is
 * untrusted input, so everything here is a security boundary (evidence/capability-calibration-v1.md).
 */

export class CalibrationSandboxUnavailableError extends Error {
  constructor(message = "bubblewrap (`bwrap`) is required to run coding calibration cases safely") {
    super(message)
    this.name = "CalibrationSandboxUnavailableError"
  }
}

export interface RunBunOptions {
  readonly timeoutMs?: number
  readonly maxStdoutBytes?: number
  readonly bwrapPath?: string | null
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 10_000
const MAX_STDOUT_BYTES = 64 * 1024

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
      if (value.byteLength >= remaining) {
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

/**
 * Runs `source` in a bubblewrap (`bwrap`) sandbox with a scrubbed environment, isolated temporary
 * filesystem, no repository access, no outbound network (`--unshare-all`), bounded stdout, resource
 * limits and a strict deadline; returns its stdout. Throws {@link CalibrationSandboxUnavailableError}
 * when `bwrap` is unavailable so the harness aborts rather than recording bogus model failures.
 */
export async function runBun(source: string, options: RunBunOptions = {}): Promise<string> {
  const bwrap = options.bwrapPath === undefined ? Bun.which("bwrap") : options.bwrapPath
  if (!bwrap) throw new CalibrationSandboxUnavailableError()
  const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_STDOUT_BYTES
  const cpuSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
  const dir = await mkdtemp(join(tmpdir(), "distpatch-cal-"))
  try {
    const file = join(dir, "case.ts")
    await Bun.write(file, source)
    const mounts = ["/usr", "/lib", "/lib64", "/bin", "/sbin"].flatMap((p) =>
      existsSync(p) ? ["--ro-bind", p, p] : [],
    )
    const proc = Bun.spawn(
      [
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
        "/work",
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
        "--bind",
        dir,
        "/work",
        "--chdir",
        "/work",
        "/bin/sh",
        "-c",
        // `ulimit` accepts only one option set per invocation under some shells (dash fails with
        // exit 2 when combining `-t`, `-f`, `-c`), so each limit is installed separately and a
        // failure aborts rather than launching the generated program unrestricted.
        `ulimit -t ${cpuSeconds} || exit 97; ulimit -v 2097152 || exit 97; ulimit -f 8192 || exit 97; ulimit -c 0 || exit 97; exec /opt/bin/bun /work/case.ts`,
      ],
      {
        cwd: dir,
        env: {},
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    )
    let timedOut = false
    let overflowed = false
    // `--die-with-parent` + `--new-session` make the sandboxed PID the process-group leader
    // inside its own session, so a negative-PID SIGKILL sweeps every forked grandchild rather
    // than leaving a fork bomb's children running against the 10 s parent deadline.
    const killProc = () => {
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProc()
    }, timeoutMs)
    try {
      const [bytes] = await Promise.all([
        readBoundedStream(proc.stdout, maxStdoutBytes, () => {
          overflowed = true
          killProc()
        }),
        proc.exited,
      ])
      if (timedOut || overflowed) return ""
      return new TextDecoder().decode(bytes)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
