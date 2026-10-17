# Model capability catalog (M2A, #7)

Code: `apps/api/src/services/capabilities/`. Tests: `apps/api/test/unit/capabilities/`.

## Purpose

Answers one question: **what is known about this model, independent of which provider or
account can serve it?** It is the static data layer the model-selection plane (#8) will read.
It does not choose a model (#8), resolve `auto-*` names (#9), or know anything about accounts.

```text
task classification -> model selection (#8 reads catalog) -> selectAccounts() -> context -> execution
```

Loaded and validated **once at boot** (`main.ts::loadBootCapabilityCatalog`), its revision logged,
and that same immutable snapshot injected through composition into virtual-model resolution
([virtual-models.md](virtual-models.md), #9) — the only consumer. Fixed-model routing,
translation and the real `/v1/models` entries never consult it; nothing re-reads the override
file after boot.

## Identity

| Concept | Example | Owner |
|---|---|---|
| Canonical id | `openai/gpt-oss-120b` (`vendor/model`, lowercase) | catalog |
| Family | `gpt-oss` (grouping only; never resolves) | catalog |
| Catalog alias | `gpt-oss-120b` (a name that identifies the profile) | catalog |
| Account alias | client name → account's upstream name | Account (`routing/model.ts`) |
| Upstream wire model | `openai/gpt-oss-120b` on Groq, `gpt-oss-120b` on Cerebras | Account / driver |

- One profile per semantic model, whatever provider serves it. No provider ids, account ids or
  availability in a profile.
- Aliases are explicit and **one hop** (alias → canonical id). There are no chains, so no cycles.
  A name claimed twice — two aliases, or an alias equal to any canonical id — fails the build.
- Lookup is exact after lowercasing. No fuzzy, substring or family matching.
- Resolution returns a profile; it never returns or alters a wire name.

## Hard facts vs preference scores

Two separate records on every profile:

- `hard`: `contextTokens`, `maxOutputTokens` (positive ints) and `textInput`, `textOutput`,
  `imageInput`, `toolUse`, `structuredOutput` (booleans). A selector **filters** on these.
- `scores`: `general`, `coding`, `reasoning`, `agentic`, `review`, `structured_output`,
  `tool_use`, `long_context`, `vision`, `speed`, `cost`, each in `[0, 1]`, higher = more
  desirable (`cost: 1` = cheapest class). A selector **compares** on these.

Contradictions fail the build: `maxOutputTokens > contextTokens`; tool use or structured output
without text output; a `vision` / `tool_use` / `structured_output` score on a model whose matching
hard feature is `false`.

`cost` and `speed` are curated static classes, not money and not telemetry. Prices stay in
`services/cost/` (provider-keyed, with their own overrides); live latency belongs to M4 (#11).

## Unknown

`null` = unknown, everywhere: omitted and explicit `null` both load as `null`, overrides keep it,
lookup returns it, JSON serializes it. `false` on a hard feature means known unsupported. No
default of `0`, `0.5`, `1` or `false` is ever substituted. #8 decides how unknown affects
eligibility: an unknown score earns no credit in ranking.

## Tags

Semantic model tags, pattern `^[a-z][a-z0-9-]{0,31}$`, e.g. `local`, `embedding`, `premium`,
`subscription`, `coding`. They describe the model, not a route. Route traits such as `free` or the
serving host belong on the Account (M1 account tags), which describe a route; #8 combines both
without either owning the other.

## Shipped bootstrap profiles

`shipped.ts`, TypeScript constants validated by Zod at build — the same shape of decision as the
shipped price and context-window tables. Schema version `1`, revision `YYYY-MM-DD.N` (bump with
any edit); current `2026-10-17.3`. Sparse on purpose, carrying verified hard facts and **no**
hardcoded preference scores (`scores` all `null`):

| Id | Case | Known hard facts | Bootstrap scores |
|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | hosted first-party | window/output from `models/windows`, text, tools | none (`null`) |
| `openai/gpt-5.5` | hosted first-party | window/output from `models/windows`, text, tools | none (`null`) |
| `openai/gpt-oss-120b` | many OpenAI-compatible hosts, differing wire ids | 131 072 context (model card), text, tools (live) | none (`null`) |
| `qwen/qwen3.8-27b` | local (ATX quant route `qwen3.8-27b`) | text, image | none (`null`) |
| `qwen/qwen3.8-flash-next` | local (Strata route `strata-qwen38-flash-next`) | text, image | none (`null`) |
| `xiaomimimo/mimo-v2.6-distill-qwen-9b` | local derivative of `qwen/qwen3.5-9b` (route `mimo-v2.6-distill-9b`) | text, image, tools, JSON schema (M1 live) | none (`null`) |
| `0bserverx/qwen3.8-27b-heretic-abliterated-uncensored` | local derivative of `qwen/qwen3.8-27b` (route `qwen3.8-27b-rvn`) | text | none (`null`) |
| `isvalorum/qwen3.6-35b-a3b-mtp-apex-i-miniplus-v2.1-abliterated` | local derivative of `qwen/qwen3.6-35b-a3b` (route `qwen36-35b-apex-v21`) | text | none (`null`) |
| `qwen/qwen3-embedding-0.6b` | local embedding-only (route `qwen3-embedding-0.6b`) | text in, **no** text out | none (`null`) |

Route context windows are route configuration (inventory), not model facts, so the local profiles
leave `contextTokens` unknown. `imageInput` is stated only where the public model documents it,
even if a given route lacks the multimodal projector.

## Capability Intelligence Pipeline

Preference scores enter through the off-request-path **Capability Intelligence Pipeline**
(`apps/api/src/services/capabilities/intelligence/`, CLI `bin/capabilities`):

```text
Artificial Analysis (implemented) ──┐
Distpatch Local Eval (supplemental)─┤
OpenEvals / HF (planned) ───────────┤
OpenRouter metadata (planned) ──────┘
                  │
                  ▼
     Evidence ingestion (bin/capabilities sync)
                  │
                  ▼
     Postgres: capability_observations (fingerprint-deduplicated observation log)
                  │
                  ▼
     Capability compiler (distpatch-cap-compiler-v1 / distpatch-cap-norm-v1)
                  │
                  ▼
     Candidate snapshot -> validation -> atomic publication (capability_snapshots)
                  │
                  ▼
     Immutable in-memory runtime catalog (zero request-path DB or HTTP calls)
```

### Evidence sources

- **Implemented — Artificial Analysis (`artificial-analysis`)**: fetches `/api/v2/language/models`
  (falling back to `/api/v2/language/models/free` on Free-tier 403) with `x-api-key: $AA_API_KEY`.
  Provides primary external evidence for hosted models on `general` (`intelligence_index / 100`),
  `coding` (`coding_index / 100`), `agentic` (`agentic_index / 100`), and `speed` (normalized from
  `median_output_tokens_per_second` and `median_time_to_first_token_seconds`). Pricing fields are
  stored as observations in Postgres for provenance but are **not** converted into a
  provider-independent semantic `cost` score.
- **Implemented — Distpatch Local Evaluation Framework (`distpatch-local-eval`)**: versioned deterministic
  suite (`apps/api/bench/calibration/`, `bin/calibrate`, code execution isolated inside a `bwrap`
  sandbox with `--unshare-all`, scrubbed environment, isolated temporary filesystem, no network,
  and resource/timeout limits). **Supplemental, stored evidence**: not cross-source comparable with
  Artificial Analysis, so it does not write shared preference scores (see Cross-source
  comparability). Saturated dimensions (> 0.90 across all measured models) stay withheld (`null`).
- **Planned future sources**:
  - **Hugging Face / OpenEvals**: reasoning, coding, and benchmark-specific capability evidence to
    fill dimensions external headline indexes omit.
  - **OpenRouter metadata**: model identity, context length, modalities, and supported parameters
    (keeping provider availability and pricing distinct from semantic capability).
  - **LMArena / human preference datasets**: corroborating evidence for general preference, vision,
    and coding/webdev.

### Explicit external identity mapping

`intelligence/identity.ts` maps `(source, externalId) → CanonicalModelId` (`vendor/model`) by exact
lowercased match only. No fuzzy matching, Levenshtein distance, or substring guessing is permitted.
Unmapped external records are persisted in `capability_observations` with
`canonical_model_id = NULL` and never enter compiled snapshots.

### Source precedence & catalog layering

Effective runtime catalog layering (`applyPublishedSnapshotToBootstrap`):

```text
1. Static bootstrap catalog (SHIPPED_CAPABILITY_CATALOG — hard facts, tags, aliases, null scores)
        ↓
2. Published capability-intelligence snapshot (Postgres capability_snapshots, state = 'published')
        ↓
3. Operator override file (MODEL_CAPABILITY_OVERRIDES_PATH — highest authority)
```

- Within the compiler, sources are **never automatically averaged**:
  - For hosted models, maintained external evidence (`artificial-analysis`) is primary for
    headline dimensions (`general`, `coding`, `agentic`, `speed`).
  - For local models (`local` tag), a quantized artifact of a public model uses that public
    model's Artificial Analysis evidence (`general`, `coding`, `agentic`); `speed` is never compiled
    (AA speed describes hosted serving, not a local route). A derivative is unscored unless a source
    measures *that* model: lineage (`baseModel`) is provenance, never score inheritance.
  - A source writes shared scores only if marked **comparable** (below).
- Every compiled score records its exact source, benchmark, benchmark version, observation
  timestamp, staleness flag (> 90 days), and `sha256` provenance digest.

### Cross-source comparability

All sources feeding a preference dimension must be calibrated onto one scale; fitting inside `[0, 1]`
is not comparability. `intelligence/comparability.ts` holds an explicit registry:

```text
evidence exists → valid? → cross-source comparable?
                             ├─ yes → production score candidate
                             └─ no  → stored evidence/provenance only
```

`artificial-analysis` is comparable (`artificial-analysis-index-100-v1`). `distpatch-local-eval` is
**not**: its pass fractions are uncalibrated against AA indexes and there is no multiplier, offset
or fitted conversion. Its observations stay in Postgres as evidence (and in the evidence digest) but
never score. A source becomes comparable only through a versioned registry entry naming its
calibration (future anchor-model calibration). Any new evidence provider follows the same rule; an
unlisted source is not comparable.

### Local Evaluation trust boundary

The normalized artifact must carry `suite`, `graderVersion` and `normalization`
(`intelligence/local-eval-versions.ts`, shared by the harness and the reader). The source accepts
only the current values; anything else (missing stamp, the pre-sandbox grader, another normalization)
is rejected as production evidence and retained as `historical_*` observations — never as zero
scores. The committed `evidence/capability-calibration-v1/scores.json` is stamped
`distpatch-grader-v1-pre-sandbox`, so it is historical until models are re-run under the sandboxed
grader.

### Local model identity layers

```text
base model → derivative semantic model → quant artifact → runtime → route alias
```

| Layer | Example | Lives in |
|---|---|---|
| Semantic model | `qwen/qwen3.8-flash-next` | capability catalog |
| Derivative lineage | `0bserverx/qwen3.8-27b-heretic-abliterated-uncensored` → `baseModel: qwen/qwen3.8-27b` | catalog (`baseModel`) |
| Artifact | `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`, `GSQ-RCO IQ2_XS` | route/artifact inventory |
| Runtime | `strata 0.1.44.1` | route/artifact inventory |
| Route alias | `strata-qwen38-flash-next` | catalog alias / provider |

Quantizing or changing runtime does not create a semantic model; a fine-tune or abliteration does.
Canonical ids are the lowercased HF repository id; exact casing lives in `sources` (provenance).

`inventory.ts` defines the provider-neutral normalized route-inventory contract (semantic identity,
base/derivative lineage, artifact identity, runtime identity, route identity, capabilities,
provenance), so MLX, llama.cpp, Ollama, OpenRouter, NVIDIA or another OpenAI-compatible provider can
describe routes without a DockerLM-specific core type. `evidence/model-inventory/dockerlm.json` is
the DockerLM instance (inspected: no host paths, addresses or credentials; committed as-is, moved
from the repository root). It is development/catalog evidence only: nothing reads it at inference,
and `local-fleet.test.ts` keeps the shipped catalog consistent with it.

Embedding-only models (`qwen/qwen3-embedding-0.6b`: `textOutput: false`, tag `embedding`) are real
profiles with truthful hard facts. They never reach a generative virtual model because the request
path (`dataplane/semantic-candidates.ts`) drops any profile that knows it cannot take or give text
before selection; unknown (`null`) text support stays a candidate, as before.

### Snapshot lifecycle & last-known-good retention

`syncCapabilityIntelligence` executes:
`fetch → validate source payload → store observations → resolve identities → compile candidate → validate candidate → publish atomically → adopt immutable snapshot`.

If any stage fails (API outage, rate limit, schema drift, DB failure, or catalog contradiction),
publication aborts and the previously published snapshot (or static bootstrap catalog before the
first sync) remains active. Inference never queries Postgres or external HTTP endpoints on the
request path.

### Observation history semantics

`capability_observations` is a **fingerprint-deduplicated observation log**, not an immutable
append-only ledger. New values insert new rows; an unchanged latest value is deduplicated. If an
older value *reappears* after an intermediate one, its existing row is re-stamped (`observed_at`,
`ingested_at`, `source_ref`, provenance) so the compiler sees it as current, which means the
intermediate period is not recorded as a row. `canonical_model_id` is also rewritten when identity
mappings change. The published snapshots (`capability_snapshots`) are the immutable audit trail.

## Operator overrides

`MODEL_CAPABILITY_OVERRIDES_PATH` names a JSON file read **once at boot**. Missing, unreadable,
non-JSON or invalid → boot fails with every problem listed by entry. Chosen over a database table
because the catalog changes with deploys, not per request, and an env-named file needs no
migration, admin CRUD, or refresh loop; DB-backed overrides can be added if runtime editing is
ever needed.

```json
{
  "schemaVersion": 1,
  "profiles": [{ "id": "local/qwen-coder", "aliases": ["qwen-coder"], "tags": ["local", "free"] }],
  "overrides": [
    { "id": "openai/gpt-5.5", "enabled": false },
    { "id": "xiaomimimo/mimo-v2.6-distill-qwen-9b", "hard": { "contextTokens": 32768 }, "scores": { "coding": null } },
    { "id": "anthropic/claude-sonnet-4-6", "tags": { "add": ["premium"] } }
  ]
}
```

- `profiles`: whole new profiles, same schema as shipped; an id already present fails.
- `overrides`: partial edits by **canonical id** (an alias or unknown id fails, duplicate target
  fails). Absent field = keep; `null` = make unknown. `tags` is `{ set }` or `{ add, remove }`.
  `aliases` / `sources` replace the list.
- Precedence: shipped → added profiles → overrides; then contradictions and alias collisions are
  re-checked on the merged result.
- `enabled: false` keeps the profile resolvable with `enabled: false`; consumers decide.
- Each profile reports `origin` (`shipped` | `operator`) and `overridden` (changed field paths).
- Strict schemas reject unknown keys, and every string is pattern-restricted (sources: https
  without query/userinfo, or `repo:` path), so account ids or credentials cannot enter.

## Versioning

`revision()` returns `{ schemaVersion, shipped, effective }`. `effective` is
`sha256:<hex>` over the sorted effective profile contents (excluding `origin`/`overridden`), so
identical effective data gives an identical revision however it was reached. A future route
decision can record it; persisting that is later work.

## Lookup interface

```ts
interface ModelCapabilityCatalog {
  resolve(model: string): ModelCapabilityProfile | null   // canonical id or alias
  get(id: CanonicalModelId): ModelCapabilityProfile | null
  list(): readonly ModelCapabilityProfile[]                // sorted, disabled included
  revision(): CatalogRevision
}
```

Synchronous `Map` lookups over frozen objects. No Postgres, file, network or discovery call after
build. No scoring, ranking or request logic.

## Missing profiles

A discovered or requested model with no profile resolves to `null`; nothing is inferred from
discovery or names. Fixed-model routing is unaffected — it never reads the catalog. Malformed
catalog **data** fails boot; an uncatalogued **model** never does. Whether a missing profile is
eligible for semantic selection is #8's decision.

## Non-goals

Model selection, demand vectors, weights, ranking (#8); `auto-*` resolution and `/v1/models`
virtual entries (#9); live quota/latency scoring (#11); classifiers (#13); context management
(#14); Auto-MoE (#15); learned or live score updates. Benchmark *data* lives in `evidence/`, the
harness in `apps/api/bench/calibration/`; neither is on the request path.
