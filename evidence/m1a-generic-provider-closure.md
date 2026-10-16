# M1A: generic provider execution closure

Date: **2026-10-16**. Code under test: **`b7eed089fa26d5e85f8b071150538957105960d5`**
(generic execution `b2f302c`, neutral tags `b7eed08`). Documentation-only changes after this
revision do not change the tested transport. No deployed service or production account was modified.

## Repository and baseline

- Fetched `origin` and added/fetched the genuine `developerz-ai/multi-ai-router` upstream.
- Fork main = upstream main = `903b486683b6d4072debd5e8bd607bc12d87242f`, v2.39.3.
- M0 tip `869aec5` is exactly five Markdown-only commits ahead of main. Worktree base is that tip.
- Branch: `m1/provider-closure-generic`; worktree: `.slim/worktrees/provider-closure-generic`.
- Read project/contribution instructions, M0 report/matrix/security/preserve findings and #2/#3/#4/#6
  bodies/comments (all initially open, no comments). User-required isolation overrides the inherited
  checkout-only note in `CLAUDE.md`.
- `bin/setup`: pinned Bun 1.4.2, isolated dev PostgreSQL 16.15 on localhost:5433, migrations applied.
  Generated local `.env` is ignored. No real provider secret copied into the worktree.
- Baseline `bin/check`: **6,803 pass, 0 fail**, lint/typecheck/build pass. Sixteen existing Biome infos
  and frontend undefined-query warnings were observed. No pre-existing failing tests were found.

## Minimum change and reproduction

Before the change, `describeProvider("openai-compatible")` offers only `openai-chat` and the
generic Responses regression suite fails. `surfaceFor()` falls back to Chat for a Responses
preference, so an arbitrary Responses-only endpoint cannot be addressed correctly under this ID.
The v2.39.3 translation improvements did not change this declaration gap.

The implementation adds a second `ProviderSurface`, not a provider ID. Existing account shape
validation derives support from `resolveDialect`, and existing egress selects `/responses` relative
to the account's authoritative base URL. Responses egress uses ordinary rules, not Codex's forced
stream/removed ceiling behavior. No translator, classifier, OAuth, encryption or routing changes.

Tests prove body/response bytes, model IDs, ordinary JSON and SSE Responses, function argument
events, usage capture, schema translation, cancellation, account-scoped selection and preserved
Chat behavior. Chat and Anthropic requests translate toward generic Responses; Responses requests
still translate toward generic Chat. Existing translation suites cover the remaining matrix.

Tags required a neutral primitive: there was no existing tag/metadata field in the account schema.
Migration 0038 adds only nullable `accounts.tags jsonb`. Admin validation bounds/normalizes strings;
create/update/read carry them without putting them into routing snapshots or pricing. Repository
fixtures were extended for the added column; ciphertext assertions and schema-shape tests remain.
The generated snapshot differs from 0037 only in migration identity and the new tags column.
Version 2.40.0 follows the repository's additive-capability version rule; no release/tag is published.

## Automated evidence

Run from the isolated worktree with the pinned Bun in PATH and its dev `DATABASE_URL`:

```sh
bin/check
bin/verify-version
bun test apps/api/test/integration/generic-responses.test.ts apps/api/test/integration/generic-provider-execution.test.ts apps/api/test/integration/provider-smoke-gate.test.ts apps/api/test/unit/accounts/provider-stream.test.ts apps/api/test/unit/accounts/tags.test.ts packages/db/test/integration/account-tags.test.ts
```

- Final `bin/check`: **6,884 pass, 0 fail across 607 files**; lint, strict project typecheck,
  PostgreSQL integration/security suites, API/CLI build and Vite build pass.
- Dedicated new suites: **80 pass, 0 fail**. One additional account-service CRUD regression in
  `apps/api/test/unit/accounts/service.test.ts` also passes in the full gate: **81 added tests**.
- `bin/verify-version`: **PASS**, five manifests + image label agree on 2.40.0.
- Smoke code is outside the canonical API `src` typecheck root. Also ran:

```sh
bunx tsc --ignoreConfig --noEmit --module preserve --moduleResolution bundler --target esnext --lib esnext --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --types bun apps/api/smoke/provider.ts
```

Result: **no errors**. Biome formatted/checks the new files. Existing sixteen lint infos remain.
Intermediate failures were test-fixture/column-order and changelog-footer updates for this change;
they were fixed without relaxing the existing security or ciphertext tests.

Generic fault injection covers 400/401/403/404/402/429/500/503 before streaming, classified failures,
secret scrubbing, no anonymous authenticated-provider call, real loopback HTTP deadline/refusal,
pre-header cancellation, broken post-output stream without replay, listing parse failures, declared
models/aliases, streaming function deltas and usage. These fixtures model protocol contracts, not
provider-specific unobserved billing or quota bodies.

## DockerLM live

```sh
DOCKERLM_BASE_URL=http://10.0.0.20:8000/v1 PROVIDER_SMOKE_MODEL=mimo-v2.6-distill-9b bin/provider-smoke dockerlm --run
```

Final run at tested code revision: **8/8 PASS**, exit 0:

| Leg | Observation |
|---|---|
| Models | GET `/v1/models`, 200, 5 entries; chosen ID present |
| Text | POST `/v1/chat/completions`, nonempty assistant text |
| Stream | SSE content plus terminal marker, 2 received chunks |
| Tools | Forced `closure_probe` function call returned |
| Stream tools | Reconstructed streamed function name + `{"ok":true}` arguments, terminal marker; 7 chunks |
| Structured | JSON-schema result parsed as an object containing boolean `ok` |
| Cancel | One streamed chunk received, AbortController aborted, reader cancelled |
| Missing model | `distpatch-nonexistent-model-probe` → 404, existing `invalid-request` classification |

Live account ID is `provider-smoke`, provider `ollama`, Chat dialect, credential `null`.
`runAttempt` is the real authenticated/header/deadline HTTP execution boundary. The smoke account
is ephemeral/in-memory, not a persisted admin-plane account; service creation and persistence are
verified separately by deterministic tests. No credential header is emitted for this account.

The first listing advertised the chosen model as `unloaded`. A subsequent ordinary inference
request succeeded and listing then reported `loaded`; no load/unload/GPU control API was invoked.
This supports **no dedicated lifecycle adapter for M1 execution** on this endpoint. It does not
prove resource scheduling or GPU release after abort. Cancellation proves local request/reader
teardown; upstream signal propagation/no replay is separately tested with stubs.

The final DockerLM smoke fixes temperature to zero and disables optional thinking through that
runtime's accepted Chat field. Tool prompts explicitly request the tool; prompt-independent tool
reliability is not claimed. Early smoke setup omitted JSON content type (corrected in the probe),
and the stream grader was strengthened to reassemble fragmented tool names rather than search
raw SSE text. Final results above come from the corrected, committed probe.

## NVIDIA live limits

No `NVIDIA_API_KEY` was present in the process environment. No private credential file was read.
Direct public HTTPS probes (Python urllib, 20-second deadline) established:

- `https://integrate.api.nvidia.com/v1/models`: **200**, standard `object` + `data`, **81 IDs**.
  No returned ID contained `free`; this does not establish whether an endpoint is billed.
- Chat request for a listed `nvidia/llama-3.1-nemotron-51b-instruct` with the explicit synthetic
  invalid bearer: **401**, top-level `status/title/detail`, invalid JWT serialization.
- Initial `meta/llama-3.1-8b-instruct` probe: **410**, explicit model EOL date, not useful as
  authentication evidence. Generic status classification is `invalid-request`; no quota inferred.

These probes did not traverse a deployed Distpatch. Shared parser/driver/data-plane behavior is
tested stub. Valid-key inference, tools, streaming, structured output, authenticated discovery and
real quota/402/429 signals remain **blocked/unobserved**. Keep #3 open. No NVIDIA driver justified.

## Zen live limits

No `ZEN_API_KEY` (or other Zen/NVIDIA-named credential variable) was present in the process
environment. Direct `https://opencode.ai/zen/v1/models` and synthetic-key Chat probes both returned
**403**, body `error code: 1010`, from this host's edge path. This is **not** a validated Zen
application auth failure, model retirement, free-model limit or quota signal.

Official endpoint documentation (`https://opencode.ai/docs/zen/`, read 2026-10-16) still distinguishes
Chat and Responses models, including free IDs. The generic Responses path is **implemented and
tested stub**; actual Zen Chat and Responses compatibility remain **blocked** by missing valid
credentials plus this host's edge restriction. Keep #4 open. No Zen-specific driver or OpenAI ID
mislabeling was introduced. Configure explicit per-surface model lists; discovery does not infer
protocols from names. Future live invocation:

```sh
# Supply keys using the operator's environment, never command-line key values.
PROVIDER_SMOKE_MODEL=LISTED_NVIDIA_ID bin/provider-smoke nvidia --run
PROVIDER_SMOKE_MODEL=ZEN_CHAT_ID bin/provider-smoke zen-chat --run
PROVIDER_SMOKE_MODEL=ZEN_RESPONSES_ID bin/provider-smoke zen-responses --run
```

`bin/provider-smoke` requires explicit `--run`, a model and endpoint/credential configuration.
Ordinary CI never invokes it against a provider; gate tests explicitly blank credential variables
to override dotenv. Output contains only result/count/classification fields, never bodies/keys.

## Preserved boundaries and remaining limitations

- No M2 routing, model substitution, quota inference, semantic metadata consumer or dashboard work.
- No dedicated DockerLM/NVIDIA/Zen driver, new ProviderId, or lifecycle/resource controller.
- No Antigravity/Vertex changes or dependency found. #6 stays open while #1/#5 and live gaps remain.
- Vision not tested. A model advertising vision is not vision verification.
- No real 402/429 load was induced. Generic taxonomy/Retry-After coverage is deterministic only.
- Successful unreadable upstream JSON intentionally retains existing 200/raw-body behavior even on
  a translated hop (`relay-translate-body.ts`); usage records success with zero counters and unknown
  cost. Listing malformed JSON is `discovery_unreadable`. This slice does not rewrite that policy.
- Same-dialect bodies are opaque apart from existing routing admission/explicit aliases. Protocol
  validation still belongs to the upstream, with its errors scrubbed and classified.
