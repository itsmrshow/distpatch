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

Semantic model tags, pattern `^[a-z][a-z0-9-]{0,31}$`, e.g. `local`, `free`, `dockerlm`,
`premium`, `subscription`, `coding`. They describe the model, not a route. Account tags (M1)
describe a route and stay on the Account; #8 combines both without either owning the other.

## Shipped profiles

`shipped.ts`, TypeScript constants validated by Zod at build — the same shape of decision as the
shipped price and context-window tables. Schema version `1`, revision `YYYY-MM-DD.N` (bump with
any edit); current `2026-10-17.1`. Sparse on purpose:

| Id | Case | Known hard facts | Calibrated scores |
|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | hosted first-party | window/output from `models/windows`, text, tools | general 1.00, coding 0.95, agentic 1.00 |
| `openai/gpt-5.5` | hosted first-party | window/output from `models/windows`, text, tools | none (no reachable route) |
| `openai/gpt-oss-120b` | many OpenAI-compatible hosts, differing wire ids | 131 072 context (model card), text, tools (live) | general 0.99, coding 1.00, agentic 0.82 |
| `mimo/mimo-v2.6-distill-9b` | DockerLM, tags `local free dockerlm` | text, tools, JSON schema (M1 live) | general 0.82, coding 0.72, agentic 1.00 |

## Preference scores: calibration

Shipped scores come only from the Distpatch calibration gate:
[`evidence/capability-calibration-v1.md`](../../evidence/capability-calibration-v1.md). A
versioned suite of deterministic, single-dimension cases (`apps/api/bench/calibration/`, run with
`bin/calibrate`, never in `bin/check`) grades each model through whatever route reaches it; the
normalizer pools routes per canonical id, takes the mean grade, and **withholds** a dimension that
every measured model passes above 0.90 (the suite has not shown it can tell models apart there).
Every shipped value equals `evidence/capability-calibration-v1/scores.json`, and a unit test fails
if they drift. Vendor benchmarks are recorded as corroboration, not converted into scores.
`speed`, `cost` and `vision` are not calibrated yet; see the evidence for why.

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
    { "id": "mimo/mimo-v2.6-distill-9b", "hard": { "contextTokens": 32768 }, "scores": { "coding": null } },
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
