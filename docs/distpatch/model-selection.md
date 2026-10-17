# Deterministic model selection (M2B, #8)

Code: `apps/api/src/services/model-selection/`. Tests: `apps/api/test/unit/model-selection/`.

## Purpose

Given concrete candidate model names, explicit request requirements, a selection policy, and the
[capability catalog](capability-catalog.md), choose one concrete model and explain why.

```text
candidates + requirements + policy + catalog
        -> hard eligibility        (reject, every failed rule recorded)
        -> ranking                 (weighted score over catalog preference scores)
        -> total-order tie-break
        -> ModelSelectionDecision  (versioned, digested)
```

`selectModel(catalog, input)` is pure and synchronous: no clock, randomness, I/O, account,
provider, quota or health state, and no classifier. Its one caller is virtual-model resolution
(#9, [virtual-models.md](virtual-models.md)), which runs it for `auto` / `auto-*` names ahead of
`selectAccounts()`, over the key's static candidate set. Fixed-model requests never enter the
selector.

## Inputs

**Candidates** — concrete model names the caller could route. Order and duplicates do not
matter. Each resolves through the catalog (canonical id or catalog alias). The selected `model`
is the candidate name **as given**, never the canonical id; the catalog never renames what goes
upstream.

**`ModelRequirements`** (Zod, strict) — hard needs of this request, all optional:
`minContextTokens`, `minOutputTokens`, `imageInput`, `toolUse`, `structuredOutput` (each
`true` when required), `requireTags`, `excludeTags` (semantic model tags). Absent = not required;
nothing is inferred.

**`SelectionPolicy`** (Zod, strict) — `id`, `version`, `weights` (per dimension, `0..100`, at least
one positive), optional `floors` (per-dimension minimum score), `unknownHardFacts`
(`reject` default | `accept`), and `preference` (canonical ids, most preferred first). The
concrete policies (`auto`, `auto-fast`, …) live in the virtual-model registry (#9).

## Hard eligibility

A candidate is rejected, with **every** failed rule listed, when:

| Reason `code` | Rule |
|---|---|
| `no-profile` | the name resolves to no catalog profile |
| `disabled` | the profile is operator-disabled |
| `feature` | a required feature is `false`, or `null` (unknown) under `unknownHardFacts: reject` |
| `limit` | context/output limit below the minimum, or unknown under `reject` |
| `tag-missing` / `tag-excluded` | semantic tag rules |
| `floor` | a policy floor's score is below it **or unknown** |

`accept` admits unknown hard facts, never known-unsupported ones. Unknown is never read as support.

## Ranking

Over weighted dimensions (weight > 0):

- `score = Σ weight·score(known) / Σ weight` — unknown dimensions **earn no credit**; they are
  not imputed.
- `coverage = Σ weight(known) / Σ weight`.
- `unknownDimensions` lists what was unknown.

Both values are rounded to 9 decimals so summation noise cannot decide a tie. Order:

1. `score` descending
2. `coverage` descending
3. position in `policy.preference` (unlisted last)
4. canonical id ascending
5. candidate name ascending

That is a total order, so the result is unique.

## Decision

```ts
interface ModelSelectionDecision {
  selectorVersion: number                          // SELECTOR_VERSION, bumped on semantic change
  policy: { id; version; digest }                  // digest over normalized policy content
  catalogRevision: { schemaVersion; shipped; effective }
  requirements: ModelRequirements                  // normalized: fixed key order, sorted tags
  outcome: "selected" | "no-eligible-model"
  selected: RankedModel | null
  ranked: RankedModel[]                            // eligible, best first
  rejected: { model; profileId | null; reasons }[] // by name
  digest: string                                   // sha256 over all of the above
}
```

Same candidates (any order), requirements, policy and catalog revision → identical decision and
digest. A policy edit without a version bump still changes `policy.digest`. `no-eligible-model`
is an outcome, not an exception; the request path maps it to `422 no_eligible_model` (#9).

## Classifier

There is none. Requirements are explicit; a classifier (#13) may later *produce* requirements,
and its failure would leave them explicit-only, never change selection semantics.

## Non-goals

Request wiring, candidate enumeration, body rewrite, usage attribution and `/v1/models` entries
are #9's ([virtual-models.md](virtual-models.md)); live quota/latency pressure (#11); classifiers
(#13); session/model affinity; account selection, which stays in `selectAccounts()`.
