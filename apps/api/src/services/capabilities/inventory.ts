import { CanonicalModelId } from "./schema"

/** Lowercase `vendor/model`; HF repository casing is kept only in provenance URLs. */
export function canonicalIdFromRepo(repo: string): CanonicalModelId {
  return CanonicalModelId.parse(repo.trim().toLowerCase())
}
