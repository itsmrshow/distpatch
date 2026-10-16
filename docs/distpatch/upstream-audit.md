# Upstream architecture audit

Pinned upstream: `developerz-ai/multi-ai-router@6d30948d560b4df2dab56be31879c143ddb24223` (v2.39.2).

## Executive finding

The selected foundation remains a strong fit. Upstream cleanly separates model admission from account selection and already implements the sensitive account/session/quota/failover/provider machinery Distpatch should preserve.

## Routing boundary

`admitRoutingModel()` parses the requested model. `orchestrator.ts` then passes that model to `selectAccounts()` through a `SelectionRequest`. `selectAccounts()` is pure over a routing snapshot and request. It resolves key scope, session binding, model support/aliases, quota and health eligibility, then applies the configured account policy.

This is the Distpatch seam: semantic model selection belongs **before** `selectAccounts()`, while provider/account selection remains downstream.

## Session and affinity

HTTP placement can be recomputed; Claude Agent SDK session bindings are durable because the upstream transcript belongs to a specific account. That distinction must survive Distpatch routing. A semantic model switch must not silently sever an SDK session that cannot be carried safely.

## Candidate planning and execution

`planCandidates()` resolves transport, egress dialect, translation mode, wire model and endpoint/config directory. `runChain()` executes bounded failover. `dispatch()` is the transport fork: HTTP uses `runAttempt()`, Claude subscription uses `runSdkAttempt()`. Both converge on shared health, accounting and response handling.

## Usage and quota

`usage_records` stores one row per upstream attempt and already distinguishes requested model from wire/upstream model. Distpatch should add selected-model attribution rather than repurpose either existing field.

`quota_windows` stores per-account/window utilization, reset instant and provenance. Unknown remains null/unknown, never unlimited. Warm health is updated immediately; durable quota writes are asynchronous and off the inference path.

## Health and breaker

Temporary `cooling_down` is mechanically distinct from standing `exhausted`, `needs_reauth`, and `disabled`. Provider-reported resets win; estimated backoff is explicitly labeled. Preserve this behavior.

## Conclusion

Do not rebuild the router. Add a narrow intelligence plane above existing account selection and keep context management as a separate later layer.