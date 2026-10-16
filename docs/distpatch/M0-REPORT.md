# Distpatch M0 final report

## Verdict

**PASS WITH FINDINGS**

M0 is complete as an architecture/provider/security audit and GitHub-hosted documentation baseline. The genuine fork exists and the audit branch is published from the fork's current `main`. No runtime behavior was changed.

The remaining GitHub-project finding is that **Issues are disabled on the fork**. The available GitHub integration cannot enable Issues or create milestones, so the 15 prepared backlog items are published verbatim under `issues/` with milestone tags, dependency sections, and acceptance criteria rather than as live issues.

## Fork and baseline

| Item | Result |
|---|---|
| fork repository | `itsmrshow/distpatch` — verified true fork of `developerz-ai/multi-ai-router` |
| default branch | `main` |
| fork `main` at M0 publication | `903b486683b6d4072debd5e8bd607bc12d87242f` (`v2.39.3`) |
| M0 audit baseline | `6d30948d560b4df2dab56be31879c143ddb24223` (`v2.39.2`) |
| relationship | fork `main` is exactly one upstream commit newer; `903b486...` directly parents from `6d30948...` |
| audit branch | `audit/m0-upstream-baseline` |
| main rewrite/reset | **none** |
| runtime changes | **none** |

The audit findings remain pinned to `6d30948...`; publication occurs on a documentation-only branch rooted at `903b486...`.

## Baseline validation

Exact-sha GitHub CI and release workflows for the audited `v2.39.2` baseline were green. Local execution was environment-limited because the earlier sandbox lacked Bun, Docker, and GitHub DNS; that was not an upstream failure. See `evidence/baseline-validation.md`.

## Current architecture

```text
/v1/* ingress
 -> createDispatcher().serve()
 -> admitRoutingModel()
 -> resolveSessionKey()
 -> optional SDK session binding lookup
 -> buildSnapshot()
 -> selectAccounts()
 -> planCandidates()
 -> runChain()
 -> bodyFor()
 -> dispatch()
    -> runAttempt() [HTTP]
    -> runSdkAttempt() [Claude subscription]
 -> health/quota + usage accounting
 -> response relay
```

The model-selection seam is directly before `selectAccounts()` in `apps/api/src/services/dataplane/orchestrator.ts`.

## Preserve map

See `evidence/preserve-map.md`. Preserve provider drivers, account model, snapshots, filtering, bindings, policies, quota windows, health/breaker, failover, translation, errors, PostgreSQL, admin/account lifecycle, aliases, and model discovery. Extend usage attribution and `/v1/models`; wrap model admission.

## Provider matrix

See `docs/distpatch/provider-matrix.md`. Key results:

- Anthropic API, Claude subscription, OpenAI API, Codex subscription, Gemini API compatibility, OpenRouter, and MiniMax have dedicated current paths.
- NVIDIA is OpenAI-compatible and should be verified through the generic driver before adding a new driver.
- Zen is partially generic-compatible; its Responses-only models expose a generic Responses compatibility gap.
- Vertex native auth/lifecycle is missing.
- Antigravity is separate from Gemini API and missing upstream.
- DockerLM can use the existing credential-less `ollama` provider for basic inference; no dedicated driver is justified yet.

## Antigravity findings

Recommended future direction: an **official `agy` CLI subprocess adapter**, not copied Google OAuth credentials. Headless stream-json supplies conversation IDs, token/cache usage, tools, and streaming; `agy models` provides model discovery; `/usage` provides quota visibility. Multi-account credential isolation remains a gating design question. See `evidence/antigravity-findings.md`.

## DockerLM findings

No dedicated provider driver is necessary for M1 inference transport. Use the existing `ollama` provider with the DockerLM `/v1` base URL, and make `local/free/dockerlm` first-class semantic tags. Revisit a dedicated adapter only if GPU/model lifecycle state materially enters routing. See `evidence/dockerlm-findings.md`.

## Distpatch insertion seam

```text
request(auto-task)
  -> admit requested model
  -> virtual resolver / deterministic model selection
  -> selected concrete model
  -> selectAccounts(selected concrete model)
  -> unchanged account/provider router
```

M1 must preserve three identities: **requested model**, **selected model**, and **upstream wire model**. See `docs/distpatch/insertion-seam.md` for the passthrough body-rewrite trap.

## Security findings

- Agent SDK remains the default Claude subscription path.
- Continuous Claude plan usage is read through the Agent SDK query object's structured usage method, not a router-owned OAuth usage HTTP call.
- Opt-in direct HTTP Claude fast mode exists and defaults off; CLI/SDK remains responsible for login and refresh.
- No auth, OAuth, crypto, credential, or wire-protocol code was modified by M0.

## Published artifacts

- six `docs/distpatch/*.md` architecture/provider/security documents
- baseline validation evidence
- preserve map
- Antigravity findings
- DockerLM findings
- 15 prepared issue bodies under `issues/`
- milestone/dependency graph in `issues/INDEX.md`
- this final report and manifest

## GitHub backlog finding

Creating a live issue currently returns GitHub `410: Issues has been disabled in this repository.` The available connector exposes issue creation/update, but not repository settings to enable Issues and not milestone creation. Therefore the backlog is fully prepared and versioned, but **0 live issues** are created. No M1 code work was started.

## M1 readiness

**READY**, with one project-management caveat: enable GitHub Issues before relying on the live issue tracker. The technical M1 entry point is stable and documented.

The recommended M1 order remains provider closure first, then the three-name model plumbing and a deterministic static virtual alias seam test. JEV/local classification, context policies, and Auto-MoE remain later milestones.
