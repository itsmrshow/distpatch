import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../../../..", import.meta.url))
for (const [args, code] of [
  [[], 64],
  [["nvidia", "--run"], 2],
  [["zen-responses", "--run"], 2],
  [["dockerlm", "--run"], 2],
] as const) {
  test(`live smoke refuses missing opt-in/configuration: ${args.join(" ")}`, async () => {
    const env = { ...process.env, PROVIDER_SMOKE_MODEL: "synthetic-model" }
    // Explicit blanks also override Bun's dotenv loader on an operator checkout.
    for (const key of ["NVIDIA_API_KEY", "ZEN_API_KEY", "DOCKERLM_BASE_URL"]) env[key] = ""
    const child = Bun.spawn([process.execPath, "apps/api/smoke/provider.ts", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(code)
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await new Response(child.stderr).text()).not.toContain("synthetic-model")
  })
}
