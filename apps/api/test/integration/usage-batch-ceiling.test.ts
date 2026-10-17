import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_STATEMENT_ROWS,
} from "@multi-ai-router/db"
import { EnvValidationError, parseEnv } from "../../src/config/env"
import { USAGE_BATCH_SIZE_MAX } from "../../src/config/fields"

/**
 * `USAGE_BATCH_SIZE`'s ceiling and the statement size the writer splits a flush into are each
 * derived in one place and *restated* in three documents an operator actually reads before
 * choosing a number. Nothing moves the prose when either moves, and prose that recommends a value
 * the router refuses at boot — or misstates what a flush costs Postgres — is worse than none.
 *
 * So the documented numbers are asserted against the derived ones rather than proof-read.
 * The file read is the assertion: the artifacts under test *are* the checked-in `.env.example`
 * and reference tables, and there is nothing to inject in their place.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const SOURCES: ReadonlyArray<{ name: string; text: string }> = [
  { name: ".env.example", text: readFileSync(`${ROOT}.env.example`, "utf8") },
  {
    name: "docs/idea/09-deployment.md",
    text: readFileSync(`${ROOT}docs/idea/09-deployment.md`, "utf8"),
  },
  { name: "apps/api/README.md", text: readFileSync(`${ROOT}apps/api/README.md`, "utf8") },
]

/** Digit-grouping differs per document (`65 535` in prose, `65535` in a shell comment). */
function mentionsNumber(text: string, value: number): boolean {
  const plain = String(value)
  const spaced = plain.replace(/\B(?=(\d{3})+(?!\d))/g, "\u{2009}")
  const thin = plain.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return text.includes(plain) || text.includes(spaced) || text.includes(thin)
}

/** The lines around each document's `USAGE_BATCH_SIZE` entry. */
function usageBatchPassage(text: string): string {
  const lines = text.split("\n")
  const at = lines.findIndex((line) => line.includes("USAGE_BATCH_SIZE"))
  expect(at).toBeGreaterThanOrEqual(0)
  return lines.slice(Math.max(0, at - 4), at + 2).join("\n")
}

describe("documented USAGE_BATCH_SIZE ceiling", () => {
  for (const source of SOURCES) {
    test(`${source.name} states the ceiling boot enforces and the statement size behind it`, () => {
      const passage = usageBatchPassage(source.text)

      expect(mentionsNumber(passage, USAGE_BATCH_SIZE_MAX)).toBe(true)
      expect(mentionsNumber(passage, USAGE_RECORD_MAX_STATEMENT_ROWS)).toBe(true)
      expect(mentionsNumber(passage, PG_MAX_BIND_PARAMETERS)).toBe(true)
      expect(mentionsNumber(passage, USAGE_RECORD_BIND_PARAMETERS_PER_ROW)).toBe(true)
    })

    test(`${source.name} still recommends a value boot accepts`, () => {
      const passage = usageBatchPassage(source.text)
      // `USAGE_BATCH_SIZE=200` in a shell comment, `` `USAGE_BATCH_SIZE` | no | `200` `` in a
      // reference table — in both the documented default is the first number after the name.
      const recommended = passage.match(/USAGE_BATCH_SIZE\D{0,20}(\d+)/)?.[1]
      expect(recommended).toBeDefined()

      const env = {
        DATABASE_URL: "postgres://router:router@postgres:5432/router",
        ADMIN_OIDC_ISSUER_URL: "https://sso.test",
        ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
        ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
        ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        USAGE_BATCH_SIZE: recommended,
      }
      expect(() => parseEnv(env)).not.toThrow(EnvValidationError)
    })
  }
})
