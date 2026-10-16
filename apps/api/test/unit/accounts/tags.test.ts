import { expect, test } from "bun:test"
import { createAccountBody, updateAccountBody } from "../../../src/services/accounts/schemas"

test("tags are bounded nonempty neutral annotations, normalized once at the write boundary", () => {
  expect(updateAccountBody.parse({ tags: [" local ", "free", "dockerlm", "free"] }).tags).toEqual([
    "local",
    "free",
    "dockerlm",
  ])
  expect(updateAccountBody.parse({ tags: [] }).tags).toEqual([])
  expect(updateAccountBody.parse({ tags: null }).tags).toBeNull()
  for (const tags of [[" "], ["x".repeat(65)], Array(33).fill("x"), "local", [1]]) {
    expect(updateAccountBody.safeParse({ tags }).success).toBe(false)
  }
  expect(createAccountBody.parse({ label: "existing", provider: "ollama" }).tags).toBeUndefined()
})
