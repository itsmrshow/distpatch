# Distpatch M0 final report

## Verdict

**PASS WITH FINDINGS**

M0 is complete as an architecture/provider/security audit and GitHub-hosted baseline. The genuine fork is verified, the documentation branch is rooted at the fork's current `v2.39.3` `main`, the complete 15-issue backlog is live, and no runtime behavior was changed.

## Baselines

- audited upstream baseline: `6d30948d560b4df2dab56be31879c143ddb24223` (`v2.39.2`)
- fork current-main baseline at publication: `903b486683b6d4072debd5e8bd607bc12d87242f` (`v2.39.3`)
- relationship: `903b486...` directly parents from `6d30948...`; the fork was created exactly one upstream commit later
- audit branch: `audit/m0-upstream-baseline`
- `main` reset/rewrite: **none**

## Published M0 findings

- architecture baseline and upstream audit
- provider matrix
- security/credential boundaries
- Antigravity findings
- DockerLM findings
- exact virtual-model insertion seam
- preserve/wrap/extend map
- upstream sync policy
- live GitHub issue/dependency backlog

## Architecture conclusion

Distpatch does not need to replace multi-ai-router. Semantic model resolution belongs directly before `selectAccounts()`. Existing provider/account selection, session bindings, quota, health, failover, translation and execution remain authoritative downstream.

Provider and Account are explicitly separate concepts. A Provider may have N independently authenticated Accounts/subscriptions, and health, quota windows, usage, exhaustion, concurrency, authorization, failures and policy remain account-scoped. Multiple subscription quotas are never merged into one synthetic provider quota. Session/cache affinity may intentionally bind work to one specific Account. The architecture documentation uses `openai-oauth` with `chatgpt-personal` and `chatgpt-business` as a non-secret example.

M1 must preserve three model identities: requested virtual/fixed model, Distpatch-selected concrete model, and actual upstream wire model.

## Remaining findings

1. GitHub milestone creation is not exposed by the available connector. Milestones are represented by `[M1]`…`[M8]` issue titles/body metadata with explicit dependency references.
2. Antigravity multi-account credential isolation remains unproven and is a gating security question for that provider workstream.
3. NVIDIA, Zen and DockerLM still require live/stub verification before they can be marked tested.
4. Vertex native auth/lifecycle is not implemented and must be implemented or explicitly deferred.
5. Claude direct HTTP fast mode exists upstream but remains security-sensitive, default off, and outside M1 scope.

## M1 readiness

**READY.** The technical seam, provider-closure backlog, multi-account invariants, preservation boundaries and security constraints are documented. M1 implementation has not begun.
