# M0 preserve / wrap / extend map

| Area | Decision | Why |
|---|---|---|
| provider drivers | **PRESERVE** | provider-specific auth, headers, failures and quota semantics are already isolated |
| provider/account separation | **PRESERVE AS INVARIANT** | a Provider is an integration type; each Account is an independently authenticated resource with its own policy and authorization boundary |
| account abstraction / multi-account pools | **PRESERVE** | many Accounts per Provider is normal and is core to subscription/account failover |
| per-account health/quota/usage | **PRESERVE** | health, quota windows, usage, exhaustion, concurrency and failures must remain account-scoped and must never be merged into one provider bucket |
| account metadata / policy | **EXTEND LATER** | Distpatch should support operator metadata such as personal/business, priority, weight, reserve, eligibility and constraints without changing Provider identity |
| routing snapshots | **PRESERVE** | clean pure input to account routing |
| scope + candidate filtering | **PRESERVE** | security boundary and model/account eligibility already correct |
| SDK session bindings | **PRESERVE** | upstream transcript ownership is physical state, not preference |
| session/cache affinity | **PRESERVE / EXTEND** | work may bind to a specific account when continuity/cache value makes switching costly; affinity remains downstream of concrete-model selection |
| account routing policies | **PRESERVE** | provider/account choice stays separate from semantic model choice |
| quota windows | **PRESERVE** | durable per-account multi-window state with source confidence; multiple subscriptions must not become one synthetic quota |
| health / circuit breaker | **PRESERVE** | temporary vs standing failures are correctly distinct and account-local |
| bounded failover | **PRESERVE** | avoids replay after streaming begins |
| usage accounting | **EXTEND** | add selected-model/decision attribution; keep requested/upstream identities and per-account attribution |
| business/workspace authorization boundaries | **PRESERVE AS INVARIANT** | business-linked accounts keep their own permissions/policy and must not inherit personal-account state merely because ProviderId matches |
| protocol translation | **PRESERVE** | orthogonal to semantic routing |
| provider failure classification | **PRESERVE** | do not leak provider semantics into model scorer |
| PostgreSQL persistence | **PRESERVE** | storage rewrite is unrelated scope |
| admin/account lifecycle | **PRESERVE** | sensitive credential/account behavior already exists |
| model aliases | **PRESERVE** | wire naming remains downstream of selected concrete model |
| provider model discovery | **PRESERVE** | useful source for capability catalog |
| requested-model admission | **WRAP** | validate request, then resolve virtual model |
| `/v1/models` | **EXTEND** | expose virtual descriptors without hiding concrete reachability |
| Claude direct HTTP fast mode | **NEEDS MORE AUDIT** | security-sensitive optimization, default off, not needed for M1 |
| context management | **NEW LATER LAYER** | independent pluggable layer, not account routing |
| semantic model selection | **NEW LAYER** | Distpatch-owned layer before `selectAccounts()` |

## Multi-account example

```text
Provider: openai-oauth
  Account: chatgpt-personal
  Account: chatgpt-business
```

The two accounts above are intentionally modeled as separate authenticated resources. They may differ in quota, permissions, cost, health, concurrency, policy, model eligibility and session affinity. Their quota windows must never be added together into one synthetic `openai-oauth` allowance.
