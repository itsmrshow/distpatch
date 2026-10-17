import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  parseLlamaSwapModelList,
  type RouteModelDescriptor,
  type StoredRouteModel,
} from "../../../src/services/capabilities"

/**
 * `GET /v1/models` body captured verbatim from the live DockerLM host on 2026-10-17 (six routes:
 * five generative, one embedding) and checked against `llamaswap-discovery.ts`: every
 * `meta.llamaswap` group the parser reads matched; the extra fields the host emits (role, kv_cache,
 * mtp, vocab_map, OpenAI-style `architecture`, …) are deliberately ignored. No host address,
 * credential or host path is in it.
 */
export const DOCKERLM_MODELS_PATH = fileURLToPath(
  new URL("../../fixtures/dockerlm-v1-models.json", import.meta.url),
)
export const NOW = new Date("2026-10-17T12:00:00.000Z")

export function dockerlmListing(): { data: Record<string, unknown>[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(DOCKERLM_MODELS_PATH, "utf8"))
}

export function dockerlmDescriptors(): readonly RouteModelDescriptor[] {
  return parseLlamaSwapModelList(dockerlmListing()).descriptors
}

/** Descriptors as the reconciler would have stored them, all present, from a `local` source. */
export function storedRows(
  descriptors: readonly RouteModelDescriptor[],
  source = "dockerlm",
  tags: readonly string[] = ["local"],
): StoredRouteModel[] {
  return descriptors.map((descriptor) => ({
    source,
    routeModelId: descriptor.routeModelId,
    descriptor,
    tags,
    status: "present",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    absentSince: null,
  }))
}
