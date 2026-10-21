# Model capability catalog (M2A, #7)

Code: `apps/api/src/services/capabilities/`. Tests: `apps/api/test/unit/capabilities/`.

## Purpose

Answers one question: **what is known about this model, independent of which provider or
account can serve it?** It is the static data layer the model-selection plane (#8) will read.
It does not choose a model (#8), resolve `auto-*` names (#9), or know anything about accounts.

```text
task classification -> model selection (#8 reads catalog) -> selectAccounts() -> context -> execution
```

Validated **at boot** (`main.ts::loadBootCapabilityCatalog`: the shipped bootstrap plus the operator
override file, which is read once; malformed data fails boot) and then held by one warm store
(`createCapabilityCatalogStore`) that adopts the published capability-intelligence snapshot before
the listener opens and re-checks Postgres on a jittered timer (`CATALOG_REFRESH_SECONDS`, default
30). Each adoption validates the layered catalog and swaps one immutable reference; a failed
refresh keeps the last-known-good catalog. That reference is injected through composition into
virtual-model resolution ([virtual-models.md](virtual-models.md), #9) — the only consumer — and
read synchronously. Fixed-model routing, translation and the real `/v1/models` entries never
consult it; nothing re-reads the override file after boot.

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
any edit); current `2026-10-17.4`. Sparse on purpose, carrying verified hard facts and **no**
hardcoded preference scores (`scores` all `null`):

| Id | Case | Known hard facts | Bootstrap scores |
|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | hosted first-party | window/output from `models/windows`, text, tools | none (`null`) |
| `openai/gpt-5.5` | hosted first-party | window/output from `models/windows`, text, tools | none (`null`) |
| `openai/gpt-oss-120b` | many OpenAI-compatible hosts, differing wire ids | 131 072 context (model card), text, tools (live) | none (`null`) |

Local and self-hosted models are **not** in this table: they arrive by route-model discovery (below)
as `discovered` profiles, so adding or removing a local model needs no source change.

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
- **Implemented — Distpatch Local Evaluation Framework (`distpatch-local-eval`)**: versioned
  deterministic suite (`apps/api/bench/calibration/`, `bin/calibrate`). Model-generated code runs
  under `bwrap` (`--unshare-all`: no network, private PID/IPC/UTS namespaces; `--clearenv`; read-only
  system, input and root mounts; writes only to a `/tmp` tmpfs) inside a transient systemd user
  scope whose cgroup limits are verified before the program starts (256 MiB memory, no swap, 64
  tasks, one CPU), plus per-process `ulimit`s; stdout/stderr are bounded while read, and a timeout
  or overflow kills the whole scope. If any setup cannot be established the run aborts
  (`CalibrationSandboxUnavailableError`) instead of grading. Each calibration invocation runs in a
  uniquely named systemd scope. The launcher remains blocked until `/proc/<pid>/cgroup` identifies
  that exact scope and verifies its memory, swap, task, and CPU limits plus write access to
  `cgroup.kill`; inherited harness cgroups and unexpected scope units are rejected.
  Timeout/output-limit termination therefore targets only the invocation’s verified scope. Pass/fail
  is decided on the host from the
  raw observations of a fixed probe list (`distpatch-grader-v3-host-oracle`); expected values never
  enter the sandbox. **Supplemental, stored evidence**: not cross-source comparable with Artificial
  Analysis, so it does not write shared preference scores (see Cross-source comparability).
  Saturated dimensions (> 0.90 across all measured models) stay withheld (`null`). When `saturated`
  names a dimension, its raw mean is retained only as non-compiling `saturated_*` audit evidence;
  any conflicting numeric score for that dimension is withheld.
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
2. Published snapshot evidence (compiled preference scores and provenance for known profiles)
        ↓
3. Discovered profiles in the published snapshot (dynamic route-model identities and facts)
        ↓
4. Operator override file (highest authority: added profiles and partial field overrides)
```

- Discovered profiles yield to bootstrap/operator canonical ids and effective aliases: a conflicting
  discovered profile is dropped, while only a conflicting discovered alias is trimmed. Operator
  aliases assigned to shipped or operator-added profiles also take precedence over discovery.
- An override for a discovered profile is applied atomically. If its merged facts contradict or its
  aliases collide with another discovered identity/alias, the entire override is rejected; the
  discovered profile remains unchanged and the report is available from `rejectedOverrides()`.
- An override targeting an id absent from the current layered catalog is inert for profile fields
  and listed by `unmatchedOverrideIds()`. Its declared aliases still reserve operator precedence
  during discovery. If the canonical profile appears, the edit applies only if valid; if it later
  disappears, it becomes unmatched again. Alias targets remain invalid.

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

The registry's `comparable` plus named-calibration gate applies to every Artificial Analysis
dimension, including `speed`; resolved raw observations remain in the evidence digest even when
they do not score.

### Local Evaluation trust boundary

The normalized artifact must carry `suite`, `graderVersion` and `normalization`
(`intelligence/local-eval-versions.ts`, shared by the harness and the reader), a `generatedAt`, and
an `inputs` entry (file, route, wire model, `recordedAt`, suite, grader) for every model it scores.
The source accepts only the current versions; anything else (missing stamp, an older grader, another
normalization, a missing or mismatched input) is rejected as production evidence and retained as
`historical_*` observations — never as zero scores. An observation is dated by the newest recorded
run behind it, not by when it was ingested.

Observation fingerprints include canonical, order-stable per-model contributing input provenance
(`file`, `profileId`, `route`, `wireModel`, `recordedAt`), not the artifact-level `generatedAt`;
changes to contributing input provenance create a distinct observation identity, while a
`generatedAt`-only restamp remains deduplicated.

`bin/calibrate score` normalizes only result files whose suite and grader equal the current ones
and lists every other file under `excluded`, so `scores.json` states exactly which runs it rests
on. Results from earlier graders are kept, unchanged, under
`evidence/capability-calibration-v1/historical/pre-sandbox/`; they are not read by the source.
The sandbox also requires the host Yama LSM and `/proc/sys/kernel/yama/ptrace_scope` set to `1`, `2`,
or `3`. Missing, unreadable, or unsupported values are rejected before candidate code runs.

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

### Route-model discovery (live, off the request path)

```text
DockerLM  GET {DOCKERLM_BASE_URL}/models        (OpenAI-compatible list, `meta.llamaswap` per entry)
        ↓  intelligence/llamaswap-discovery.ts   validate; semantic id only if valid + verified
        ↓  RouteModelDescriptor                  provider-neutral (route, semantic, base, artifact,
        ↓                                        runtime, capabilities, routing, provenance)
        ↓  reconcileRouteModels                  new / changed / absent; outage ⇒ nothing changes
        ↓  route_model_inventory (Postgres)      history kept, never deleted
        ↓  compileCapabilitySnapshot             present routes → `discovered` profiles in the snapshot
        ↓  capability_snapshots → in-memory catalog   the only thing inference reads
```

Run with `bin/capabilities sync` (a manual sync fetches Artificial Analysis, Local Evaluation and
every configured route source; `--route-fixture <file>` replays a saved `/v1/models` body,
`--no-route-discovery` skips it). Sync and discovery have no scheduler yet; a future one calls the
same `syncCapabilityIntelligence`. (The running router only *polls for published snapshots*; it
never syncs.) **Inference never calls `/v1/models`**: discovery runs only in the sync, and a test
drives a real dataplane request through virtual-model selection with fetch, the repository, the
discovery client and the compiler all guarded, and asserts none of them is called.

`RouteModelSource` (`route-discovery.ts`) is the provider-neutral contract (`id`, contributed `tags`,
`discover()`); the llama-swap/DockerLM adapter is one implementation, and Ollama, MLX, another
OpenAI-compatible host or NVIDIA need only a new adapter mapping their listing into
`RouteModelDescriptor`. Nothing in the core types is DockerLM-specific.

Mapping and trust rules for `meta.llamaswap`:

| `meta.llamaswap` | `RouteModelDescriptor` |
|---|---|
| `model_identity.semantic_model` | `semanticModelId` — lowercased `vendor/model`, used only when valid **and** `provenance.confidence` is `verified` |
| `model_identity.base_model` / `derivative_model` | `baseModelId` / `derivativeModelId` (a `(via …)` annotation is dropped); a profile gets `baseModel` only when base ≠ semantic |
| `artifact`, `runtime` | stored route evidence (repository, files, format, quantization; name, version) — never the profile |
| `model_capabilities` | `capabilities` (text/image in, text out, embedding, context) → profile hard facts; a route lacking an image projector is *unknown*, not unsupported; route context windows stay route-level |
| `routing` (`model_type`, `endpoint`) | `routing`; `embedding`, `model_type=embedding` or a `/embeddings` endpoint marks an embedding model |
| `provenance` | `provenance`; the semantic source URL becomes a profile source |

The adapter was validated against a live DockerLM `GET /v1/models` (2026-10-17, six routes): every
group above matched, and the host's extra fields (`role`, `kv_cache`, `mtp`, OpenAI-style
`architecture`, …) are ignored. The test fixture is that capture.

An entry **without** `meta.llamaswap` is kept as an unresolved route (no profile). An entry whose
metadata is present but malformed is rejected: skipped, and its previous row is kept (an untrusted
entry is not evidence of removal). An unreadable or empty listing rejects the whole discovery.

Reconciliation: a new verified model appears in the next published snapshot; a quant/runtime/artifact
change updates the route evidence without changing semantic identity (only a changed
`semanticModelId` does); a model that disappears turns `absent` (excluded from compilation, row
retained); a route alias already claimed by a bootstrap or earlier profile is dropped rather than
failing the build. **Last-known-good**: a down host, timeout, HTTP error or unreadable answer leaves
stored routes and the published snapshot untouched and is reported in the sync result; Distpatch
never needs the host to boot, and tags (`local`) come from the source, not from model names.

`capabilities/inventory.ts` only holds the schema of the flat inventory document
`evidence/model-inventory/dockerlm.json` and the canonical-id normalization. That file is a
**fixture / evidence example**; it is not an operational source and nobody copies it from DockerLM.
A test keeps it consistent with the discovery fixture.

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

Ordering: only one `sync` runs at a time — it holds a session advisory lock from discovery and
evidence fetching through publication, and a second, overlapping `sync` fails fast without writing
(so fetches that finish out of order cannot make an older reading the latest one). Evidence writes,
identity re-binding and route reconciliation take the publication lock, and reading the
observations and route inventory, compiling, saving the candidate and publishing run in one
transaction holding it, so a `compile` always publishes from the newest committed evidence and
cannot regress the published snapshot. `generatedAt` describes a snapshot; it is not the ordering
primitive. A partial unique index allows at most one `published` row.

The public publication callback accepts only `candidate` builds; `rejected`, `published` and
`superseded` build states are refused before stored history is consulted. A rejected historical
revision therefore cannot be reactivated, and an invalid first publication cannot become published
without its first `publishedAt`.
`latestSnapshot` history is ordered by `generatedAt` regardless of publication state and can therefore
be superseded; the row whose state is `published` is authoritative for the active catalog, including
when an older revision is reactivated.

### Observation history semantics

`capability_observations` is a **fingerprint-deduplicated observation log**, not an immutable
append-only ledger. New values insert new rows; an unchanged latest value is deduplicated. If an
older value *reappears* after an intermediate one, its existing row is re-stamped only when its
measurement timestamp (`observed_at`) advances; a later `ingested_at` alone does not make the same
measurement fresh. This keeps provenance-addressed Local Eval run identities from becoming new
evidence through delayed re-ingestion. Sources without an upstream measurement timestamp may
use fetch time as `observed_at` (Artificial Analysis does), so a later read can still represent
newer evidence. The
intermediate period is not recorded as a row. `canonical_model_id` is also rewritten when identity
mappings change. Published snapshot content (including its payload, generation time, compiler and
normalizer versions, evidence digest, summary, and first `publishedAt`) is immutable even after it is
superseded; republishing that revision changes only its lifecycle state. A candidate that has never
been published retains the existing replaceable-candidate behavior.

## Operator overrides

`MODEL_CAPABILITY_OVERRIDES_PATH` names a JSON file read **once at boot**. Missing, unreadable,
non-JSON or schema-invalid files fail boot with every problem listed by entry. Override content is
validated at boot even when a target is absent: duplicate targets, aliases colliding with bootstrap
or operator ids/aliases or another override alias, and contradictions within explicitly supplied
facts remain fatal. An absent target does not receive its field edits, though its declared aliases
still reserve precedence during discovery. A discovered-target override that conflicts with
discovered facts or aliases is rejected atomically and reported without blocking snapshot adoption.
Chosen over a database table because the catalog changes with deploys,
not per request, and an env-named file needs no migration, admin CRUD, or refresh loop; DB-backed
overrides can be added if runtime editing is ever needed.

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

- `profiles`: whole new profiles, same schema as shipped; an id already present in the bootstrap
  or another operator profile is an error. If discovery supplies the same id, the discovered profile
  is dropped; discovered aliases that collide with an operator id or effective profile alias are
  trimmed.
- `overrides`: partial edits by **canonical id** (an alias remains an error; an absent id is inert
  and reported in `unmatchedOverrideIds()`, duplicate target fails). Absent field = keep; `null` =
  make unknown. `tags` is `{ set }` or `{ add, remove }`; `aliases` / `sources` replace the list.
- Precedence: shipped → discovered → operator-added profiles → operator field overrides. Operator
  profiles and overrides win over discovered identities when valid; invalid discovered-target
  edits leave the discovered profile unchanged and appear in `rejectedOverrides()`.
- `enabled: false` keeps the profile resolvable with `enabled: false`; consumers decide.
- Profiles report `origin` (`shipped` | `discovered` | `operator`) and `overridden` (changed field
  paths). Unmatched ids and rejected discovered-target overrides are logged at boot and when either
  reported set changes.
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
