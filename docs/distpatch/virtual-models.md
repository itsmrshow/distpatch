# Virtual model resolution (M2C, #9)

Code: `apps/api/src/services/virtual-models/` (registry, selector seam),
`apps/api/src/services/dataplane/model-choice.ts` (request resolution, decision trace),
`semantic-candidates.ts` (candidate enumeration), `virtual-listing.ts` (`/v1/models`).
Tests: `apps/api/test/unit/virtual-models/`, `apps/api/test/unit/dataplane/model-choice.test.ts`,
`apps/api/test/integration/virtual-models.test.ts`.

## Architecture

```text
client body: "model": "auto-research"
        |
admitRoutingModel()                     requestedModel = auto-research
        |
chooseModel()                           reserved namespace?  no  -> fixed path, untouched
        |  yes
virtual registry lookup                 unknown / inactive   -> 404 model_not_found
        |
scopedConcreteModels(key scope)         static: configured names in scope, no health/quota
        |
selectModel(catalog, policy, reqs)      no eligible          -> 422 no_eligible_model
        |
selectedModel = concrete name           decision trace logged
        |
selectAccounts(model = selectedModel)   existing scheduler: scope, health, quota, bindings,
        |                               failover, reserves — unchanged
account alias map / context tag         upstreamModel
        |
passthrough rewrite or translation      the wire never carries auto-*
```

Resolution happens in the orchestrator immediately after `admitRoutingModel()` and **before** the
session-binding read and every account decision. `selectAccounts()` — and the `GET /v1/models/:id`
reachability probe, its only other caller — never receives `auto` or an `auto-*` name.

The capability catalog is loaded once at boot (`main.ts::loadBootCapabilityCatalog`, override
file included, malformed data still fails boot), logged with its revision, and the same immutable
snapshot is injected through `RuntimeDeps.capabilities` into the dispatcher and the `/v1/models`
routes (`VirtualModelRouting`). There is no singleton and no request-path file read, query,
network call or catalog rebuild.

## Three model identities

| Identity | Meaning | Fixed request | Virtual request |
|---|---|---|---|
| `requestedModel` | exactly what the client's body says | `gpt-5.5` | `auto-research` |
| `selectedModel` | the concrete model Distpatch selected | — (none happened) | `claude-sonnet-4-6` |
| `upstreamModel` | the wire name after the Account's alias map / context tag | `gpt-5.5` or its alias | selected name or its alias |

Account selection, model-support checks, alias mapping, planning, output ceilings, model metadata
and translation all see the **selected** model; the requested name is for attribution only.

### Usage attribution

| Column | Fixed | Virtual |
|---|---|---|
| `usage_records.model` | requested concrete name | requested virtual name |
| `usage_records.selected_model` | `NULL` | selected concrete name |
| `usage_records.upstream_model` | wire name (unchanged behavior) | wire name |

`selected_model` (migration `0039_selected_model`) is a nullable text column with no default and no
back-fill: `NULL` means a fixed request, a request refused before selection, or a row written before
the column existed. Every attempt of one request carries the same `model` and `selected_model`;
only `upstream_model` varies, per account alias, across a failover.

### Passthrough body rewrite

The raw body still says `"model":"auto-task"` even when the selected and upstream names agree, so
`chain-body.ts::bodyFor()` rewrites when `upstreamModel !== requestedModel` — never against the
selected model. Fixed requests are byte-identical unless an alias or stripped context tag renamed
them, exactly as before. Translated bodies are built from the upstream name; a translated response
whose upstream names no model falls back to the concrete selected model, never `auto-*`.

## Active virtual models

Registry version `1`. Each policy id is the virtual id, version `1`. Weights are relative
importance over catalog preference dimensions; omitted dimensions are not considered. No policy
has a `preference` list, floors, or a hidden ranking.

| Id | Intent | Weights | Hard requirements |
|---|---|---|---|
| `auto` | Balanced general-purpose quality | general 40, reasoning 30, agentic 15, tool_use 15 | — |
| `auto-fast` | Low latency by **static** speed class | speed 65, general 35 | — |
| `auto-task` | Reliable task execution and agentic tool use | agentic 35, tool_use 30, general 20, reasoning 15 | `toolUse` |
| `auto-research` | Reasoning over long context | reasoning 35, long_context 30, general 20, tool_use 15 | — |
| `auto-plan` | Planning: reasoning and agentic structure | reasoning 40, agentic 25, long_context 20, general 15 | — |
| `auto-review` | Review and judging, code included | review 40, reasoning 25, coding 20, general 15 | — |
| `auto-max` | Highest semantic quality, regardless of speed/cost | general 25, reasoning 25, coding 15, agentic 15, review 10, long_context 10 | — |
| `auto-local` | Local inference only, ranked like `auto` | general 40, reasoning 30, agentic 15, tool_use 15 | tag `local` |

Limitations: `auto-fast` reads the catalog's static `speed` class, never live latency; `auto-max`
is not tied to any provider or `premium` tag; `auto-local` is only as truthful as the `local` tag
on capability profiles (the DockerLM seed carries it); `auto-task` rejects a model whose tool use is
unknown (`unknownHardFacts: reject`).

### Unknown capability data

Scores are not invented. The shipped profiles carry no preference scores, so until an operator
supplies measured scores (override file) every eligible candidate scores `0` with coverage `0`
and the M2B total order decides: policy preference (none) → canonical id → candidate name. That is
deterministic and documented, not a quality judgement. Synthetic scores appear only in tests.

### Request-derived requirements

None in M2C. The body scanner reads only the model and a bounded conversation prefix; there is no
cheap, provider-independent extraction of tools, images, structured output or token counts, and
M2C adds no parser, tokenizer or prompt inspection. Requirements come from the descriptor alone.

## Reserved, inactive names

Distpatch owns `auto` and everything starting `auto-`, case-insensitively and with or without a
trailing context tag (`auto[1m]`). Lookup of an active id is exact: no case folding, aliases or
fuzzy matching. Any other reserved name answers `404 model_not_found` before account selection.

- **`auto-free` — reserved, not active.** "Free" is usually a property of the route (provider,
  account, plan), not of the model: the same weights are paid on one host and free on another. The
  catalog's semantic `free` tag is not treated as proof of a free route, and account selection has
  no route-level "free only" constraint today. Activating it would mean either faking it through a
  model tag or moving account/billing policy into the semantic selector; both are refused. It
  needs an explicit execution constraint passed to account selection, which is later work.
- **`auto-moe` — reserved for Auto-MoE (#15).** No fan-out, experts, judging or merging exists.

## Candidate enumeration

`scopedConcreteModels(catalog, keyScope, capabilities, models)` returns the sorted, unique
requested-side names the key's **configured** scope can route, exactly as `GET /v1/models` names
them (`listableModelIds`, held equal to `listableModels`: declared `supportedModels`, alias keys, a
subscription's catalog rows), **that identify a capability profile** (canonical id or catalog
alias, case-insensitive). An uncatalogued name could only ever be rejected as `no-profile`, so it is
not enumerated and pays no support check.

- scope is the configured intersection (all / pools / account list), from the warm catalog;
- the only status read is the operator's `disabled`;
- **not** read: health, breaker state, cooldowns, `exhausted` / `needs_reauth` overlays, quota
  windows, rate-limit readings, latency, concurrency, reserves, spend;
- a passthrough account declaring no models contributes only its alias keys;
- names in the reserved namespace are never candidates;
- a profile that declares `hard.textInput: false` or `hard.textOutput: false` is never a
  candidate: every active virtual model is a chat policy whose winner is sent a text inference
  body, and a policy need not require either fact, so such a profile could otherwise win on score.
  `null` (unknown) stays a candidate. This also keeps `GET /v1/models` from offering an `auto-*`
  backed only by non-text models. A fixed request for such a model is untouched;
- the candidate keeps the account's own spelling (`Deep`), which is what routing and the wire use.

An account alias key (`sonnet → glm-4.7`) is a candidate under the client-facing name only; it
resolves to a capability profile only if that name is itself a catalog id or catalog alias. The
capability catalog never rewrites the wire name. Two candidate names for one profile tie on score
and fall to candidate-name order, so the winner is deterministic.

After a concrete model is selected, account selection runs normally and may still answer `429`,
`402`, `403` or `503` from live state; M2C does not fall back to a second model.

## Errors

| Situation | Status | Code |
|---|---|---|
| Reserved but unknown / inactive virtual name (`auto-x`, `auto-moe`, `auto-free`) | 404 | `model_not_found` |
| Active virtual model, no eligible concrete candidate in scope | 422 | `no_eligible_model` |
| Virtual model on `POST /v1/embeddings` | 400 | `invalid_request` |
| Account cooldown / quota / credits / provider failure after selection | existing | existing |
| Malformed request | existing | existing |

The 422 message names the virtual model, the policy id/version, the catalog effective revision,
the catalogued candidate count and rejection reason counts (`2 candidate(s): tag-missing ×2`) — no
model list, account, provider or credential. Rendered by the normal dialect-aware `RouterError`
path; usage outcome `no_healthy_account` (capacity the operator configures), `selected_model`
`NULL`.

### Operations

- **Inference** (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`): resolved as above.
- **Token counting** (`/v1/messages/count_tokens`): resolved to the same concrete model a matching
  inference request would get (same inputs, same decision), then planned normally.
- **Embeddings**: refused for virtual models — the catalog has no embedding dimension, and a chat
  policy would choose blind. Fixed embedding models are unchanged.

## Decision trace

Each resolved virtual request logs one structured `info` line, `msg: "virtual model selected"`,
`component: "model-selection"`, with `requestId`, `correlationId`, `requestedModel`,
`selectedModel`, `selectedProfile`, `policyId`, `policyVersion`, `policyDigest`,
`catalogRevision` (effective), `selectorVersion`, `decisionDigest`, and eligible/rejected counts.
No prompt, completion or credential. Decisions are not persisted beyond this line.

## Discovery

- `GET /v1/models`: the real listing exactly as before (minus any real name inside the reserved
  namespace, which no request could reach), followed by active virtual models in id order.
  A virtual model is listed for a key only when its policy has an eligible candidate under that
  key's static scope — so it never blinks with a cooldown. Entries are router-owned:
  OpenAI `owned_by: "distpatch"`, no `resolved_model`, no `context_length` /
  `max_completion_tokens`; Anthropic `max_input_tokens: null`, `max_tokens: null`.
- `GET /v1/models/:id`: a reserved name is answered before the concrete reachability probe — an
  active, eligible one returns the router-owned entry; anything else `404 model_not_found`, the
  endpoint's existing "not reachable for this key" answer. Concrete ids are unchanged.

## Performance

A fixed request pays one namespace check (≈0.1 µs). A virtual request does synchronous work over
warm memory: one pass over in-scope accounts' listable names with a catalog `Map` lookup each, the
support check for catalogued names only, the M2B ranking and two sha256 digests. Measured on this
branch: ≈130 µs per virtual request with 30 accounts × 29 declared names (870 names, 4 catalogued);
`bin/bench` (fixed models) unchanged and under budget. No query, file, network, classifier or extra
provider call.

## Relation to non-negotiable 4

"The client picks the model" still holds: the client explicitly names a Distpatch policy, and
Distpatch never substitutes or downgrades a concrete model name a client sends.

## Out of scope

JEV / classifiers (#13); learned routing; live quota-, health- or latency-aware semantic scoring
(#11); model/account or session/cache affinity; context compression and management (#14);
Ponytail; Caveman; Auto-MoE (#15); OMP mapping (#10); Hermes mapping (#12); persisted route
decisions; request-derived hard requirements; cross-model fallback after account failure.
