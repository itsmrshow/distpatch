import { appendFileSync } from "node:fs"
import { CalibrationSandboxUnavailableError, runBun } from "../../bench/calibration/sandbox"

/**
 * Whether the calibration sandbox suites in `suite` must skip on this host.
 *
 * Same contract as the database gate (database-gate.ts): a skip is allowed only when nothing
 * promised the sandbox. `CI` and `ROUTER_TEST_REQUIRE_SANDBOX=1` (exported by bin/check) turn an
 * unavailable sandbox into a failure, and every skip is recorded for bin/test to report after
 * bun's green summary, so a run that proved less never reads like one that proved more.
 */
export async function calibrationSandboxSkipped(suite: string): Promise<boolean> {
  const required = Boolean(process.env.CI) || process.env.ROUTER_TEST_REQUIRE_SANDBOX === "1"
  try {
    const probe = await runBun('console.log("SANDBOX_GATE_OK")')
    if (probe.trim() !== "SANDBOX_GATE_OK") {
      throw new CalibrationSandboxUnavailableError("sandbox gate probe returned unexpected output")
    }
    return false
  } catch (error) {
    if (!(error instanceof CalibrationSandboxUnavailableError) || required) throw error
    const reportPath = process.env.ROUTER_TEST_SANDBOX_SKIP_REPORT_FILE
    if (reportPath) appendFileSync(reportPath, `${suite}\n`)
    return true
  }
}
