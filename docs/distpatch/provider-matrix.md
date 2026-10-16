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
| Gemini API | **fully supported for Google OpenAI compatibility** | `gemini` dedicated HTTP driver | API key encrypted by router | OpenAI Chat compatibility API | Standard model listing; Google error/RetryInfo parsing | Active Google path for Distpatch; current requirement is satisfied by Gemini API and its available free allocation |
| Vertex AI | **explicitly deferred for M1** | No native Vertex path is planned in M1; base-URL override is not treated as full support | N/A — no ADC/service-account lifecycle is being added | Not implemented; Gemini API satisfies the current Google requirement | N/A while deferred | Revisit only for a concrete Vertex-specific need such as ADC/service accounts, org/project/region controls, or Vertex-only features |
| Google Antigravity | **missing — M1C gate BLOCKED** | None. M1C proved no supported isolation selector exists in the tested version and deliberately shipped no adapter | Would be official `agy` CLI/keyring, **not** router storage | Not implemented | `agy models` tested live on agy 1.2.14→1.4.0 (13 IDs, tab-separated, no JSON output); `/usage` unverified | No supported isolation selector found in the tested version; container/OS-user alternatives unproven and security-review-gated |
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

### New integration decisions

- **Antigravity:** dedicated official-CLI execution adapter or generalized CLI transport.
  **M1C investigated this and the gate returned BLOCKED** — see
  [M1C evidence](../../evidence/m1c-antigravity-isolation.md). M1C was **tested live on `agy`
  1.2.14 → 1.4.0** (the CLI self-updated mid-session; 1.4.0's surface was then re-verified in an
  isolated `HOME`), and found **no supported isolation selector** in the tested version, against a
  single-slot credential and a single operator account. Container and OS-user alternatives are
  **unproven** and security-review-gated, not disproven. **No adapter was implemented.** Do not
  start implementation until a second operator-authorized identity and an explicitly reviewed
  isolation design both exist.
- **Vertex:** **explicitly deferred for M1.** The current Google requirement is satisfied by the
  existing Gemini API path and its available free allocation. Distpatch has no current Vertex-specific
  workload, ADC/service-account requirement, org/project/region requirement, or Vertex-only feature
  gap. Native Vertex support should be reconsidered only when a concrete use case appears; its absence
  does **not** block M1 closure or progression to M2.

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

## M1 provider disposition

M1 provider closure is based on **implemented, tested, blocked, or explicitly deferred** status with
recorded evidence; it does not require forcing every conceivable provider integration into production.

| Target | M1 disposition | M1 blocker? |
|---|---|---|
| DockerLM | **Complete** — live + deterministic verification through existing `ollama` transport | No |
| NVIDIA | Generic path implemented/tested; authenticated live verification remains blocked on operator credentials | **Decision pending:** either run live smoke when credentials are available or explicitly defer that verification tail |
| OpenCode Zen | Generic Chat/Responses path implemented/tested; authenticated live verification remains blocked on credentials/network edge | **Decision pending:** either run live smoke when access is available or explicitly defer that verification tail |
| Antigravity | **Blocked by M1C security gate**; no adapter implemented; future work requires a second identity + reviewed isolation design | No — tracked as blocked future work |
| Vertex AI | **Explicitly deferred**; Gemini API satisfies the current Google requirement | No |

Accordingly, Antigravity and Vertex do **not** block progression to M2. The minimum remaining M1
provider decision is the disposition of the NVIDIA and Zen authenticated-live verification tails,
followed by updating/closing umbrella issue #6.

## M1C Antigravity isolation evidence

Full procedure and verbatim findings: [M1C evidence](../../evidence/m1c-antigravity-isolation.md).
Test date **2026-10-16**; Distpatch baseline `3e69744443baebb0b25a76557d9e911eb55968c9`.
**Tested live on `agy` 1.2.14 → 1.4.0** — the CLI self-updated in the background mid-session, and
1.4.0's help/subcommand/flag surface was then re-verified directly in an isolated `HOME`.

| Question | Result |
|---|---|
| Supported isolation selector in the tested version | **None found** — no flag, subcommand, or honored env var; `AGY_ACCOUNT` selects *plugin* accounts, not the model-serving identity; `ANTIGRAVITY_CONFIG_REL_DIR` is not honored as an override |
| Credential model | **Single slot** — one 0600 file, one token object; sign-in replaces, never adds |
| Operator identities available | **One** |
| Deterministic isolation selector | None observed in the tested version |
| Container / OS-user alternatives | **Unproven**, security-review-gated — not disproven |
| Adapter | **None implemented** |
| Verdict | **BLOCKED** — no adapter code written, credential boundary unchanged |

Verified-working capabilities, for a future re-attempt: `agy models` returns 13 model IDs as
tab-separated `id<TAB>label` (no JSON flag); `--output-format stream-json` emits an `init` event
carrying `conversation_id`; `--print` requires the prompt **attached to the flag**. Changelog 1.3.3
establishes that headless runs failing after partial output exit **3** with an `AGY_ERROR` line.
