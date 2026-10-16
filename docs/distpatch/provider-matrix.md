# Provider matrix

The registry table preserves M0's upstream audit classifications for unchanged providers. The M1A
section records executed evidence for the generic/local paths. M1A test date: **2026-10-16**;
tested implementation: **`b7eed089fa26d5e85f8b071150538957105960d5`**.

| Distpatch target | M1 status | Current implementation path | Auth / credential owner | Primary dialect / execution | Discovery & quota | Important limitation |
|---|---|---|---|---|---|---|
| Anthropic API | **fully supported** | `anthropic-api` dedicated HTTP driver | API key encrypted by router | Anthropic Messages | HTTP model listing; response signals | Preserve |
| Claude subscription | **fully supported, sensitive** | `anthropic-oauth` Agent SDK transport | Claude CLI / per-account `CLAUDE_CONFIG_DIR`; CLI/SDK owns login + refresh | Agent SDK by default | SDK handshake models; SDK rate-limit events + continuous SDK `/usage` gauge | Opt-in direct HTTP fast mode exists; default remains off |
| OpenAI API | **fully supported** | `openai-api` dedicated HTTP driver | API key encrypted by router | OpenAI Chat + Responses | HTTP model listing; rate-limit/error signals | Preserve |
| Codex / ChatGPT subscription | **fully supported, sensitive** | `openai-oauth` dedicated HTTP/OAuth driver | Router performs OAuth/PKCE/device flow and refresh; tokens encrypted at rest | ChatGPT Codex Responses backend | Dedicated model family/listing + quota parsing | Provider-specific private/product backend compatibility surface |
| Gemini API | **fully supported for Google OpenAI compatibility** | `gemini` dedicated HTTP driver | API key encrypted by router | OpenAI Chat compatibility API | Standard model listing; Google error/RetryInfo parsing | Active Google path for Distpatch; current requirement is satisfied by Gemini API and its available free allocation |
| Vertex AI | **explicitly deferred** | No native Vertex path planned for the current milestone | N/A — no ADC/service-account lifecycle is being added | Not implemented; Gemini API satisfies the current Google requirement | N/A while deferred | Revisit only for a concrete Vertex-specific need such as ADC/service accounts, org/project/region controls, or Vertex-only features |
| Google Antigravity | **M1C security gate BLOCKED** | None; M1C deliberately shipped no adapter | Would be official `agy` CLI/keyring, not router storage | Not implemented | `agy models` tested live on agy 1.2.14→1.4.0; `/usage` unverified | No supported isolation selector found in the tested version; container/OS-user alternatives remain unproven and security-review-gated |
| OpenRouter | **fully supported** | `openrouter` dedicated HTTP driver | API key encrypted by router | OpenAI Chat | Model listing + provider signals | Preserve |
| NVIDIA hosted NIM/API Catalog | **M1 complete via generic path** | `openai-compatible`, `https://integrate.api.nvidia.com/v1` | bearer API key | OpenAI Chat | Public listing tested live; generic transport/discovery/errors tested deterministically | Provider-specific authenticated smoke and real 402/429/quota payloads remain optional operational validation, not an M1 blocker |
| OpenCode Zen | **M1 complete via generic Chat/Responses path** | `openai-compatible`, separate Chat/Responses accounts | bearer API key | Chat default; Responses explicitly pinned per account | Generic listing/parser and both protocol surfaces tested deterministically | Provider-specific authenticated smoke remains optional operational validation; prior edge 403/1010 is not treated as Zen application behavior |
| MiniMax | **fully supported** | `minimax` dedicated HTTP driver | API key encrypted by router | Anthropic-compatible | Model discovery and provider failure parsing | Preserve |
| DockerLM | **tested live + tested stub** | Existing `ollama` transport; operator `/v1` URL | credential-less LAN endpoint | OpenAI Chat | Live listing: 5 models; ordinary request autoloaded a listed unloaded model | No lifecycle adapter justified; no vision/GPU-reclamation claim |
| Generic OpenAI-compatible | **implemented; tested** | `openai-compatible` | API key required, including Responses | Chat default + account-selected Responses | Shared authenticated `/models` parser | Surface choice is per account, not inferred per model; local anonymous endpoints still use `ollama` |
| Generic Anthropic-compatible | **fully supported** | `anthropic-compatible` | API key required | Anthropic Messages | Standard listing/parser | Preserve |

## Current declared provider IDs

The current source declares:

`anthropic-oauth`, `anthropic-api`, `openai-oauth`, `openai-api`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `groq`, `deepseek`, `xai`, `mistral`, `together`, `cerebras`, `ollama`, `openai-compatible`, `anthropic-compatible`.

NVIDIA and OpenCode Zen intentionally do **not** require dedicated provider IDs for M1. They are
represented through the provider-neutral `openai-compatible` account path and API-key auth.

## M1 provider decisions

### Generic OpenAI-compatible providers

- **NVIDIA:** accepted for M1 through `openai-compatible`. Public `/models` behavior was exercised
  live and the generic transport, auth requirement, streaming/tool/cancellation behavior, error
  taxonomy and provider-neutral tags are covered by M1A tests. A dedicated NVIDIA driver is not
  justified unless real use exposes provider-specific semantics the generic path cannot represent.
  Authenticated provider smoke is deferred to normal operational validation when a key is available.
- **OpenCode Zen:** accepted for M1 through `openai-compatible`. M1A closed the demonstrated generic
  Responses gap by adding an account-selectable `openai-responses` surface while preserving Chat as
  default. Zen Chat/Responses can therefore be represented with ordinary API-key accounts. Live
  provider smoke is deferred until a valid key and edge-accepted network path are available.
- **DockerLM:** remains a first-class local target through the existing `ollama` transport because it
  permits credential-less OpenAI Chat endpoints and preserves a distinct local provider identity.

The M1 closure rule is architectural: when an upstream exposes an OpenAI-compatible endpoint using
ordinary API-key authentication and Distpatch's tested generic path represents the required surface,
M1 does not require a bespoke driver or provider-specific live credential smoke. Live smoke remains
valuable operational validation and should create follow-up work only if it discovers a real
incompatibility.

### New/sensitive integration decisions

- **Antigravity:** M1C investigated the official `agy` CLI path and returned **BLOCKED**. See
  [M1C evidence](../../evidence/m1c-antigravity-isolation.md). It was tested live across the
  1.2.14→1.4.0 self-update and found no supported model-serving identity isolation selector in the
  tested version, against a single-slot credential and one operator identity. Container and OS-user
  alternatives are unproven and security-review-gated, not disproven. **No adapter was implemented.**
  Resume only with a second operator-authorized identity and an explicitly reviewed isolation design.
- **Vertex:** **explicitly deferred.** Gemini API satisfies the current Google requirement and its
  available free allocation. Distpatch has no current Vertex-specific workload, ADC/service-account
  requirement, org/project/region requirement, or Vertex-only feature gap. Native Vertex support is
  not an M1 or M2 progression blocker.

## M1A execution evidence

Detailed commands, boundaries and failure findings: [M1A evidence](../../evidence/m1a-generic-provider-closure.md).
Live smoke uses an ephemeral in-memory account and the real `runAttempt`/driver HTTP transport; it
does not provision a persistent deployed-router account. Stub tests drive the real Hono data plane,
account service and PostgreSQL repository. The two evidence levels are complementary.

| Target / account ID in evidence | Surface / auth | Discovery | Chat / Responses | Streaming / tools | Cancellation / structured output | Vision | Dedicated driver |
|---|---|---|---|---|---|---|---|
| DockerLM / live `provider-smoke`, stub `dockerlm` | `ollama`, Chat; no credential, no auth header | **tested live**: 5 IDs; **tested stub** shared parser + declared models | Chat **tested live**, `mimo-v2.6-distill-9b`; Responses **not applicable** to this transport | Text, forced function and streaming function **tested live**; byte relay/accounting **tested stub** | Client abort **tested live**; propagated signal/no replay **tested stub**; JSON schema **tested live** | **deferred**, despite model advertisement | No transport or lifecycle driver justified |
| NVIDIA / stub `nvidia` | `openai-compatible`, Chat; bearer required | Public GET **tested live**: 81 IDs; same shape **tested stub** | Chat **tested stub**; valid-key live smoke **deferred after M1** | **tested stub** | **tested stub** | **deferred** | No demonstrated generic defect requiring one |
| Zen Chat / stub `zen-chat` | `openai-compatible`, Chat; bearer required | **tested stub**; live provider smoke **deferred after M1** | Chat **tested stub** | **tested stub** | **tested stub** | **deferred** | No demonstrated need |
| Zen Responses / stub `zen-responses` | `openai-compatible`, `openai-responses`; bearer required | **tested stub**; live provider smoke **deferred after M1** | Generic Responses path **implemented, tested stub** | Responses events + function arguments **tested stub** | **tested stub**, including Chat `response_format` → Responses `text.format` | **deferred** | No Zen-specific conditional added |
| Shared generic mechanism / `openai-chat`, `openai-responses` | Account-specific explicit dialect; default Chat preserved | **tested stub** for both surfaces | Same-dialect bytes and supported cross-dialect pairs **tested stub** | Usage tokens and transformed tool IDs **tested stub** | Abort, malformed requests, transport deadlines **tested stub** | No new assertion | Existing driver only |

### Discovery and identity

- Admin discovery calls the shared listing parser and can save nonempty IDs to `supportedModels`.
  The warm catalog sweep discovers without silently changing routing declarations.
- `/v1/models` enumerates account-declared models and aliases within key scope. An unknown-model
  passthrough account advertises no enumerable models there; discovered-only entries appear in
  `/v1/catalog`. Discovery is not performed on the request-critical path.
- Alias keys replace their mapped upstream IDs in the advertised list; other declared IDs remain.
  Free suffixes and namespaced IDs are preserved. Aliases change wire names only when explicit.
- A mixed-protocol Zen listing must not be blindly saved to both accounts: declare each surface's
  model IDs explicitly. No automatic protocol or semantic model selection was added.
- Nullable provider-neutral account `tags` are implemented and tested through validation, service
  CRUD and real PostgreSQL migration/repository. `["local", "free", "dockerlm"]`,
  `["nvidia", "free"]`, or `["zen", "free"]` can record operator assertions. They do not change
  routing, billing, prices, quotas, or model capabilities.

### Failure and quota evidence

| Target | Live findings | Deterministic evidence / remaining limits |
|---|---|---|
| DockerLM | Missing ID → 404 `invalid-request`; unloaded listed model autoloads on ordinary request; no quota headers observed | 400/401/403/404/402/429/5xx, connection refusal, deadline, abort, broken stream **tested stub**. Auth/402/429 cases are generic fault injection, not claims about the local runtime's billing/auth behavior. |
| NVIDIA | Listed model + invalid synthetic bearer → 401; retired `meta/llama-3.1-8b-instruct` → 410 EOL | 401/403 → `auth`; 404/410 → `invalid-request`; 429 → `rate-limited`; 402 → `credits-exhausted`; 5xx → `server-error` **tested stub**. Actual provider billing/quota signals remain unobserved and unknown. |
| Zen, both surfaces | Public listing/synthetic-key probe from the test host reached an edge 403/1010 | This is not treated as Zen application auth/quota evidence. Generic failure taxonomy and both protocol paths are tested stub; provider-specific live semantics remain unknown until observed. |
| Shared | No provider-specific quota interpretation added | Failure bodies scrub selected credentials; missing required credential makes no upstream call. `Retry-After` is parsed by existing logic; unknown quota stays unknown. |

## M1 provider disposition — CLOSED

M1 provider closure is based on an explicit **implemented, tested, blocked, or deferred** disposition
with recorded evidence. It does not require forcing every conceivable provider integration into
production or withholding M2 on unavailable third-party credentials.

| Target | Final M1 disposition | Blocks M2? |
|---|---|---|
| DockerLM | **Complete** — live + deterministic verification through existing `ollama` transport | No |
| NVIDIA | **Complete for M1** — represented by tested generic `openai-compatible` + API-key path; provider-specific authenticated smoke deferred to operations | No |
| OpenCode Zen | **Complete for M1** — represented by tested generic Chat/Responses + API-key path; provider-specific authenticated smoke deferred to operations | No |
| Antigravity | **Blocked by M1C security gate**; no adapter implemented; future work requires a second identity + reviewed isolation design | No |
| Vertex AI | **Explicitly deferred**; Gemini API satisfies the current Google requirement | No |

Umbrella issue **#6 is complete**. NVIDIA issue **#3** and Zen issue **#4** are complete for M1 under
the generic compatibility rule; future live smoke is operational validation rather than milestone
gating. Vertex issue **#5** is explicitly deferred. Antigravity issue **#1** remains open and
security-blocked for future work.

**M1 provider closure is complete. Proceed to M2.**

## M1C Antigravity isolation evidence

Full procedure and findings: [M1C evidence](../../evidence/m1c-antigravity-isolation.md).
Test date **2026-10-16**; Distpatch baseline `3e69744443baebb0b25a76557d9e911eb55968c9`.
The investigation observed `agy` 1.2.14 self-update to 1.4.0 and re-verified 1.4.0 directly in an
isolated `HOME`.

| Question | Result |
|---|---|
| Supported isolation selector in the tested version | **None found** — no flag, subcommand, or honored env var; `AGY_ACCOUNT` selects plugin accounts, not the model-serving identity |
| Credential model | **Single slot** — one 0600 file, one token object; sign-in replaces rather than adding accounts |
| Operator identities available | **One** |
| Container / OS-user alternatives | **Unproven**, security-review-gated — not disproven |
| Adapter | **None implemented** |
| Verdict | **BLOCKED** — credential boundary unchanged |

Verified useful capabilities for a future re-attempt: `agy models` returns model IDs as tab-separated
`id<TAB>label`; `--output-format stream-json` emits an `init` event carrying `conversation_id`; and
headless failures after partial output are documented by the CLI as a distinct nonzero failure path.
