# M0 preserve / wrap / extend map

| Area | Decision | Why |
|---|---|---|
| provider drivers | **PRESERVE** | provider-specific auth, headers, failures and quota semantics are already isolated |
| account abstraction / multi-account pools | **PRESERVE** | core foundation for subscription/account failover |
| routing snapshots | **PRESERVE** | clean pure input to account routing |
| scope + candidate filtering | **PRESERVE** | security boundary and model/account eligibility already correct |
| SDK session bindings | **PRESERVE** | upstream transcript ownership is physical state, not preference |
| account routing policies | **PRESERVE** | provider/account choice stays separate from semantic model choice |
| quota windows | **PRESERVE** | durable multi-window state with source confidence |
| health / circuit breaker | **PRESERVE** | temporary vs standing failures are correctly distinct |
| bounded failover | **PRESERVE** | avoids replay after streaming begins |
| usage accounting | **EXTEND** | add selected-model/decision attribution; keep requested/upstream identities |
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