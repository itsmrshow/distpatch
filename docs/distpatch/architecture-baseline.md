# Distpatch architecture baseline

Audit date: `2026-10-16T14:48:00-04:00`  
Pinned upstream: `developerz-ai/multi-ai-router@6d30948d560b4df2dab56be31879c143ddb24223`  
Upstream release: `v2.39.2`

## Architectural invariant

Distpatch keeps five decisions separate:

1. task / role classification
2. model selection
3. provider / account selection
4. context management
5. provider execution

The intended request flow is:

```text
client / harness
  -> compatible ingress
  -> requested model admission
  -> Distpatch virtual model resolver        [new]
  -> Distpatch concrete model selection      [new]
  -> existing selectAccounts()               [preserve]
  -> existing candidate planning             [preserve]
  -> future context policy layer             [separate, not M0/M1]
  -> existing provider execution             [preserve]
```

The key rule is unchanged from the project design: **Distpatch chooses the concrete model; the existing router chooses the eligible provider/account for that model.**

## Provider and Account are separate concepts

This is a permanent Distpatch invariant inherited from upstream's explicit design that **many Accounts per Provider is the normal case**.

- A **Provider** is a kind of upstream integration: protocol, authentication mechanism, endpoints, model namespace, and provider-specific behavior.
- An **Account** is one independently authenticated credential/subscription attached to that provider.
- One provider may have **N accounts**, each with independent authorization, quota, health, cost, permissions, concurrency, usage, and failure state.
- Distpatch model selection must never collapse those accounts into one provider-level resource bucket.

Concrete example:

```text
Provider: openai-oauth
  Account: chatgpt-personal
  Account: chatgpt-business
```

Those labels are operator-facing examples only. They do not contain or imply stored credentials or real external account identifiers.

For the two accounts above, Distpatch must treat the following as independently observable and independently actionable:

- health / circuit-breaker state
- quota windows and reset times
- usage and exhaustion
- concurrency / in-flight work
- provider failures and reauthentication state
- model permissions / availability
- account-specific cost or subscription policy
- eligibility for a particular request or role

**Quotas from multiple subscriptions must never be merged into one synthetic quota bucket.** Two ChatGPT subscriptions are two independently constrained resources, not one enlarged ChatGPT allowance.

Business/workspace-linked accounts retain their own authorization and policy boundaries. A business account must not implicitly inherit the permissions, quota, model access, routing policy, or eligibility of a personal account under the same provider.

Session/cache affinity may intentionally bind work to a specific account when continuity, provider cache reuse, or upstream session ownership makes switching costly or invalid. Existing account/session affinity therefore remains part of account selection, not semantic model selection.

The ordering rule is:

```text
Distpatch selects a concrete model / provider-compatible target
  -> account eligibility is evaluated
  -> one specific Account is selected
  -> provider execution occurs with that Account only
```

Routing must never assume accounts under one provider have identical quota, permissions, cost, or policy.

Distpatch should eventually expose account metadata/policies such as:

- `personal` / `business` / other operator-defined class
- priority
- weight
- reserve / protected capacity
- role/task eligibility
- model allow/deny constraints
- cost preference
- concurrency limits
- local/free/premium preference where applicable

These are **account-level policy inputs**. They do not change the Provider definition and they do not justify merging account telemetry.

## Verified current request path

The current request path at the pinned SHA is:

```text
apps/api/src/routes/v1/index.ts
  -> dispatcher.serve(...)
apps/api/src/services/dataplane/orchestrator.ts
  -> readRequestBodyWithProgress(...)
  -> admitRoutingModel(...)
apps/api/src/services/dataplane/body/preflight.ts
  -> resolveSessionKey(...)
apps/api/src/services/dataplane/body/session.ts
  -> session binding lookup (when Agent SDK transport is present)
apps/api/src/services/dataplane/session-binding.ts
  -> buildSnapshot(...)
  -> selectAccounts(...)
apps/api/src/services/routing/select.ts
  -> resolveScope(...)
  -> evaluateBinding(...)
  -> filterCandidates(...)
  -> policy ordering
  -> planCandidates(...)
apps/api/src/services/dataplane/plan.ts
  -> runChain(...)
apps/api/src/services/dataplane/chain.ts
  -> bodyFor(...)
apps/api/src/services/dataplane/chain-body.ts
  -> dispatch(...)
apps/api/src/services/dataplane/dispatch.ts
     -> HTTP: runAttempt(...)
     -> Claude subscription: runSdkAttempt(...)
  -> response/error observation
  -> health/quota update
  -> usage record
  -> relay response
```

Ingress routes implemented by `apps/api/src/routes/v1/index.ts`:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `GET /v1/models`
- `GET /v1/models/:id`
- `GET /v1/catalog`
- `GET /v1/providers`

## Current model identity

Current upstream has two model identities:

- **requested model**: the exact client-supplied name, stored as `RuntimeInput.model` and `usage_records.model`
- **upstream model**: the account alias/context-tag resolved wire name, stored as `Candidate.upstreamModel` and `usage_records.upstream_model`

Distpatch requires a third identity:

```text
requested_model          = auto-task
selected_model           = claude-sonnet-...      # Distpatch decision
upstream_model           = provider wire name      # existing alias result
```

Do not repurpose the existing requested-model field. Add selected-model attribution explicitly.

## Persistence baseline

Retain PostgreSQL initially. The current design intentionally keeps database work off the hot inference path using warm snapshots/caches and asynchronous usage/quota writers. A storage rewrite is unrelated to M0 and would unnecessarily increase scope.

## Decisions captured

- Distpatch separates model selection from provider/account selection.
- Provider and Account remain separate concepts; N independently authenticated accounts per provider are expected.
- Health, quota, usage, exhaustion, concurrency, permissions, failures and policy remain account-scoped.
- Multiple subscription quotas are never merged into one synthetic provider quota.
- Session/cache affinity may bind work to a specific account where valuable.
- Existing multi-ai-router provider/account/quota machinery is preserved initially.
- Current PostgreSQL implementation is retained for initial development.
- Context management remains a separate future layer.
- Virtual `auto-*` models resolve before existing account selection.
- `6d30948d560b4df2dab56be31879c143ddb24223` is the M0 implementation baseline.
