# Provider matrix

The registry table preserves M0's upstream audit classifications for unchanged providers. The M1A
section below supersedes the four generic/local rows with executed evidence, not a provider-wide
support claim. M1A test date: **2026-10-16**; tested implementation: **`b7eed089fa26d5e85f8b071150538957105960d5`**.

| Distpatch target | M0 status | Current implementation path | Auth / credential owner | Primary dialect / execution | Discovery & quota | Important limitation |
|---|---|---|---|---|---|---|
| Anthropic API | **fully supported** | `anthropic-api` dedicated HTTP driver | API key encrypted by router | Anthropic Messages | HTTP model listing; response signals | Preserve |
| Claude subscription | **fully supported, sensitive** | `anthropic-oauth` Agent SDK transport | Claude CLI / per-account `CLAUDE_CONFIG_DIR`; CLI/SDK owns login + refresh | Agent SDK by default | SDK handshake models; SDK rate-limit events + continuous SDK `/usage` gauge | Opt-in direct HTTP fast mode now exists; default remains off |
| OpenAI API | **fully supported** | `openai-api` dedicated HTTP driver | API key encrypted by router | OpenAI Chat + Responses | HTTP model listing; rate-limit/error signals | Preserve |
| Codex / ChatGPT subscription | **fully supported, sensitive** | `openai-oauth` dedicated HTTP/OAuth driver | Router performs OAuth/PKCE/device flow and refresh; tokens encrypted at rest | ChatGPT Codex Responses backend | Dedicated model family/listing + quota parsing | Provider-specific private/product backend compatibility surface |
| Gemini API | **fully supported for Google OpenAI compatibility** | `gemini` dedicated HTTP driver | API key encrypted by router | OpenAI Chat compatibility API | Standard model listing; Google error/RetryInfo parsing | Not native Google GenAI protocol |
| Vertex AI | **missing native auth/path** | Base URL override exists, but no ADC/service-account lifecycle | N/A | N/A | N/A | A URL override is not a complete Vertex integration |
| Google Antigravity | **missing** | No upstream Antigravity code | Future: prefer official `agy` credential boundary | Future official CLI/subprocess adapter | `agy models`; `/usage`; stream-json usage metadata | Multi-account isolation and machine-readable quota need verification |
| OpenRouter | **fully supported** | `openrouter` dedicated HTTP driver | API key encrypted by router | OpenAI Chat | Model listing + provider signals | Preserve |
| NVIDIA hosted NIM/API Catalog | **partially tested** | `openai-compatible`, `https://integrate.api.nvidia.com/v1` | bearer API key; no valid key available in this run | OpenAI Chat | Public listing tested live; inference tested stub | Authenticated inference remains blocked |
| OpenCode Zen | **tested stub; live blocked** | `openai-compatible`, separate Chat/Responses accounts | bearer API key; no valid key available in this run | Chat default; Responses explicitly pinned | Standard listing parser tested stub; live edge 403/1010 | Generic Responses gap closed; actual Zen compatibility still unproven |
| MiniMax | **fully supported** | `minimax` dedicated HTTP driver | API key encrypted by router | Anthropic-compatible | Model discovery and provider failure parsing | Preserve |
| DockerLM | **tested live + tested stub** | Existing `ollama` transport; operator `/v1` URL | credential-less LAN endpoint | OpenAI Chat | Live listing: 5 models; ordinary request autoloaded a listed unloaded model | No lifecycle adapter justified; no vision/GPU-reclamation claim |
| Generic OpenAI-compatible | **implemented; tested stub** | `openai-compatible` | API key required, including Responses | Chat default + account-selected Responses | Shared authenticated `/models` parser | Surface choice is per account, not inferred per model; local anonymous endpoints still use `ollama` |
| Generic Anthropic-compatible | **fully supported** | `anthropic-compatible` | API key required | Anthropic Messages | Standard listing/parser | Preserve |

## Current declared provider IDs

The pinned source declares:

`anthropic-oauth`, `anthropic-api`, `openai-oauth`, `openai-api`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `groq`, `deepseek`, `xai`, `mistral`, `together`, `cerebras`, `ollama`, `openai-compatible`, `anthropic-compatible`.

## Required provider work after M0

### Verify rather than build first

- **NVIDIA:** hosted API is OpenAI-compatible at `/v1/chat/completions`. Start with the generic driver and add a dedicated driver only if provider-specific error/quota/model semantics materially improve routing.
- **OpenCode Zen:** generic Responses capability is implemented and tested stub in M1A. Finish authenticated live checks for both surfaces before declaring Zen verified.
- **DockerLM:** use `ollama` as the initial transport because it permits credential-less OpenAI Chat endpoints and preserves a distinct local provider identity.

### New integration required

- **Antigravity:** dedicated official-CLI execution adapter or generalized CLI transport.
- **Vertex:** official ADC/service-account-aware integration if Vertex is required as a Distpatch target.

## M1A execution evidence

Detailed commands, boundaries and failure findings: [M1A evidence](../../evidence/m1a-generic-provider-closure.md).
Live smoke uses an ephemeral in-memory account and the real `runAttempt`/driver HTTP transport;
it does not provision a persistent deployed-router account. Stub tests drive the real Hono data
plane, account service and PostgreSQL repository. The two evidence levels are complementary.

| Target / account ID in evidence | Surface / auth | Discovery | Chat / Responses | Streaming / tools | Cancellation / structured output | Vision | Dedicated driver |
|---|---|---|---|---|---|---|---|
| DockerLM / live `provider-smoke`, stub `dockerlm` | `ollama`, Chat; no credential, no auth header | **tested live**: 5 IDs; **tested stub** shared parser + declared models | Chat **tested live**, `mimo-v2.6-distill-9b`; Responses **not applicable** to this transport | Text, forced function and streaming function **tested live**; byte relay/accounting **tested stub** | Client abort **tested live**; propagated signal/no replay **tested stub**; JSON schema **tested live** | **deferred**, despite model advertisement | No transport or lifecycle driver justified |
| NVIDIA / stub `nvidia` | `openai-compatible`, Chat; bearer required | Public GET **tested live**: 81 IDs; same shape **tested stub** | Chat **tested stub**; valid-key live **blocked**; Responses **deferred**, not requested for NVIDIA | **tested stub** | **tested stub** | **deferred** | No demonstrated generic defect requiring one |
| Zen Chat / stub `zen-chat` | `openai-compatible`, Chat; bearer required | **tested stub**; live **blocked** by edge 403/1010 | Chat **tested stub**; valid-key live **blocked** | **tested stub** | **tested stub** | **deferred** | No demonstrated need |
| Zen Responses / stub `zen-responses` | `openai-compatible`, `openai-responses`; bearer required | **tested stub**; live **blocked** | Generic Responses path **implemented, tested stub**; actual Zen **blocked** | Responses events + function arguments **tested stub** | **tested stub**, including Chat `response_format` → Responses `text.format` | **deferred** | No Zen-specific conditional added |
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
- Nullable provider-neutral account `tags` are **implemented and tested** through validation,
  service CRUD and real PostgreSQL migration/repository. `["local", "free", "dockerlm"]`,
  `["nvidia", "free"]`, or `["zen", "free"]` can record operator assertions. They do not change
  routing, billing, prices, quotas, or model capabilities. No per-model tag catalog or UI added.

### Failure and quota evidence

| Target | Live findings | Deterministic evidence / remaining limits |
|---|---|---|
| DockerLM | Missing ID → 404 `invalid-request`; unloaded listed model autoloads on ordinary request; no quota headers observed | 400/401/403/404/402/429/5xx, connection refusal, deadline, abort, broken stream **tested stub**. Auth/402/429 cases are generic fault injection, not claims about the local runtime's billing/auth behavior. |
| NVIDIA | Listed model + invalid synthetic bearer → 401; retired `meta/llama-3.1-8b-instruct` → 410 EOL even before useful auth evidence | 401/403 → `auth`; 404/410 → `invalid-request`; 429 → `rate-limited`; 402 → `credits-exhausted`; 5xx → `server-error` **tested stub**. Actual 402/429/quota signals **not observed**. |
| Zen, both surfaces | Public listing and synthetic-key Chat probe → edge 403, body `error code: 1010` | Not evidence of Zen application authentication, quota, free-model availability or Responses behavior. Generic failure taxonomy **tested stub**; valid-key live remains **blocked**. |
| Shared | No provider-specific quota interpretation added | Failure bodies scrub selected credentials; missing required credential makes no upstream call. `Retry-After` is parsed by existing logic; unknown quota stays unknown. Successful unreadable JSON retains upstream's 200/raw bytes and existing zero token counters with unknown cost; see evidence limitations. |

M1A leaves #6 open: #1 Antigravity and #5 Vertex remain outstanding, as do authenticated live
NVIDIA/Zen checks. No implementation dependency on #1 or #5 was found.
