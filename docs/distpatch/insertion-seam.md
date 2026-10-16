# Distpatch virtual-model insertion seam

Pinned upstream: `6d30948d560b4df2dab56be31879c143ddb24223`

## A. Exact current boundary

The requested model is admitted in:

`apps/api/src/services/dataplane/body/preflight.ts::admitRoutingModel()`

and is first passed to account selection in:

`apps/api/src/services/dataplane/orchestrator.ts`, inside the request dispatcher, where the local `select()` closure calls:

```text
selectAccounts(buildSnapshot(...), {
  sessionKey,
  model,
  keyScope,
  binding,
  rotationCounter
}, ...)
```

That call boundary is the insertion seam.

## B. Can `auto-task` resolve before `selectAccounts()`?

**Yes.** The account router can remain semantically unchanged if Distpatch resolves the virtual request to a concrete model before constructing `SelectionRequest.model`.

Proposed flow:

```text
request body contains: auto-task
        |
        v
admitRoutingModel()                  existing validation
        |
        v
requestedModel = auto-task
        |
        v
virtualModelResolver()               NEW
        |
        v
selectedModel = concrete-model      NEW result
        |
        v
selectAccounts(... model=selectedModel ...)
        |
        v
existing account/provider routing   UNCHANGED
```

## C. Downstream model-bearing objects that need explicit handling

### Must receive the selected concrete model for behavior

- `SelectionRequest.model`
- candidate model-support checks / alias mapping
- concrete model metadata lookup used for request ceilings/capabilities
- account planning and translation inputs

### Must preserve the original requested model for attribution

- request progress/logging
- client-facing error/decision explanation
- `usage_records.model`
- route-decision observability

### Must preserve current wire model behavior

- `Candidate.upstreamModel`
- `ServableCandidate.upstreamModel`
- translation output
- usage `upstream_model`

## Critical body-rewrite trap

`dataplane/chain-body.ts::bodyFor()` currently rewrites the raw passthrough body only when:

```text
servable.upstreamModel != ctx.runtime.model
```

Today `ctx.runtime.model` is the exact model text found in the original request bytes. If M1 simply changes it to the selected concrete model, an `auto-task` request with no account alias can incorrectly leave `"model":"auto-task"` in the passthrough JSON body because the selected and upstream models match each other even though neither matches the original bytes.

M1 therefore needs explicit three-name state:

```text
requestedModel = auto-task              # model encoded in client body
selectedModel  = claude-sonnet-...      # Distpatch decision
upstreamModel  = claude-sonnet-...      # after existing account alias mapping
```

The raw-body rewrite decision must compare `upstreamModel` against **requestedModel**.

## D. Observability

Preserve both requested virtual and selected concrete identities. In practice keep all three:

| Field | Meaning |
|---|---|
| `requested_model` | exact client request (`auto-task`) |
| `selected_model` | Distpatch concrete model choice |
| `upstream_model` | actual wire model after existing account aliasing |

Do not overwrite existing `usage_records.model`, whose current documented meaning is the client-requested name. Add `selected_model` (nullable for fixed/non-Distpatch historical traffic) and later a route decision ID/policy version.

## E. `/v1/models` design

Current real-model discovery and reachability should remain intact.

Extend the endpoint additively:

```text
current reachableModels(key scope)
        +
configured Distpatch virtual model descriptors
        =
/v1/models response
```

Rules:

- never create fake provider accounts for virtual model names
- do not call current `selectAccounts()` with `auto-*`
- `GET /v1/models/:id` needs a virtual-model branch before the current concrete reachability probe
- preserve current real models and their scope-aware reachability
- expose virtual metadata as router-owned metadata, not fabricated upstream ownership
- preferably suppress a virtual model when its policy has zero concrete candidates reachable under the presenting key, once the capability catalog exists

## Smallest safe M1 seam patch

Before semantic scoring, prove the plumbing with deterministic static mappings:

```text
auto-task -> configured concrete model
```

Add three-name attribution and raw-body rewrite tests, while leaving `selectAccounts()`, provider selection, failover, auth, and drivers untouched. This validates the seam without introducing classifier, capability scoring, quota-aware semantic choice, context compression, or MoE.
