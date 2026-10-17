# Distpatch virtual-model insertion seam

Status: **implemented in M2C (#9)**. Full design: [virtual-models.md](virtual-models.md).

Pinned upstream at investigation: `6d30948d560b4df2dab56be31879c143ddb24223`.

## A. The boundary

The requested model is admitted in
`apps/api/src/services/dataplane/body/preflight.ts::admitRoutingModel()` and reaches account
selection in `apps/api/src/services/dataplane/orchestrator.ts`, whose `select()` closure calls
`selectAccounts(buildSnapshot(...), { sessionKey, model, keyScope, binding, rotationCounter })`.

M2C inserts one synchronous step between the two:

```text
admitRoutingModel()                     requestedModel (exact body text)
        |
chooseModel()                           dataplane/model-choice.ts
        |    fixed   -> selectedModel null, concrete = requestedModel   (one namespace check)
        |    virtual -> registry descriptor + static candidates + selectModel()
        |               -> selectedModel; or 404 / 422 / 400 before any account is considered
        v
selectAccounts(... model = concreteModel ...)    unchanged
        |
existing account/provider routing                unchanged
```

`concreteModel = selectedModel ?? requestedModel`. `selectAccounts()` and the
`GET /v1/models/:id` probe are its only callers, and both now sit behind a reserved-namespace
check: neither ever receives `auto` or `auto-*`.

## B. Model-bearing objects

### Receive the concrete model (behavior)

- `SelectionRequest.model` and recovery hints (`hintRecoveryRejections`)
- candidate model-support checks and alias mapping (inside `selectAccounts()`)
- planning, output ceilings and model metadata (`Candidate.upstreamModel` derives from it)
- translation: request bodies use the upstream name; `TranslationContext.model` (the response's
  fallback name when an upstream omits one) is the concrete model

### Keep the requested model (attribution)

- `RequestProgress.model`, `RuntimeInput.requestedModel`, `usage_records.model`
- the passthrough rewrite comparison (below)
- the decision trace and client-facing errors

### Keep the selected model

- `RuntimeInput.selectedModel` / `RequestProgress.selectedModel` → `usage_records.selected_model`
  on every attempt (preflight failures included); `NULL` for fixed requests

### Unchanged wire behavior

- `Candidate.upstreamModel`, `ServableCandidate.upstreamModel`, translation output,
  `usage_records.upstream_model`

## C. The body-rewrite trap — closed

`dataplane/chain-body.ts::bodyFor()` rewrites the passthrough body when

```text
servable.upstreamModel !== ctx.runtime.requestedModel
```

The raw bytes carry the requested name, so a virtual request whose selected and upstream names
agree is still rewritten (`auto-task` → `alpha`), while a fixed request with no alias stays
byte-identical. Asserted byte-for-byte in `test/integration/virtual-models.test.ts`.

## D. Observability

| Field | Meaning |
|---|---|
| `usage_records.model` | exact client request (`auto-task`) |
| `usage_records.selected_model` | Distpatch concrete choice; `NULL` for fixed / legacy rows |
| `usage_records.upstream_model` | wire model after the account alias |

Each virtual request also logs one `virtual model selected` line with the policy id/version and
digest, catalog effective revision, selector version and decision digest. Route decisions are not
persisted.

## E. `/v1/models`

`withVirtualModels()` appends router-owned virtual entries to the unchanged real listing, only
those with an eligible candidate under the key's static scope. `virtualModelProbe()` answers
reserved names on `GET /v1/models/:id` before the concrete reachability probe. No fake provider
accounts, no `resolved_model`, no fixed size claims.
