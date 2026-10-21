import { readFileSync } from "node:fs"
import type { CapabilityCatalogWithUnmatchedOverrides } from "./build"
import { buildCapabilityCatalog, CapabilityCatalogError } from "./build"
import { SHIPPED_CAPABILITY_CATALOG } from "./shipped"

/**
 * Boot-time load: the shipped table plus the operator's override file
 * (`MODEL_CAPABILITY_OVERRIDES_PATH`), read once, before the listener opens. A missing, unreadable
 * or malformed file fails boot — the same contract as a malformed environment variable. After
 * this returns, every read is an in-memory `Map` lookup.
 */
export function loadCapabilityCatalog(
  overridesPath: string | null,
): CapabilityCatalogWithUnmatchedOverrides {
  return buildCapabilityCatalog(
    SHIPPED_CAPABILITY_CATALOG,
    overridesPath === null ? null : readCapabilityOverridesFile(overridesPath),
  )
}

export function readCapabilityOverridesFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new CapabilityCatalogError([`overrides file ${path}: ${(error as Error).message}`])
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CapabilityCatalogError([
      `overrides file ${path}: not valid JSON (${(error as Error).message})`,
    ])
  }
}
