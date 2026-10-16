# Provider matrix

This matrix is based on the pinned upstream implementation, with current official provider documentation used only where a required Distpatch target is not implemented upstream.

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
| NVIDIA hosted NIM/API Catalog | **generic-compatible, unverified live** | `openai-compatible` can target `https://integrate.api.nvidia.com/v1` | NVIDIA API key encrypted by router | OpenAI Chat | Standard discovery likely available; provider-specific quota mapping not dedicated | Dedicated driver unnecessary unless signals/quirks justify one |
| OpenCode Zen | **partially generic-compatible** | Chat-completions models can use `openai-compatible` | Zen API key encrypted by router | Generic driver is Chat only | Provider model list not integrated | Zen also serves Responses-only models; generic Responses compatibility is missing |
| MiniMax | **fully supported** | `minimax` dedicated HTTP driver | API key encrypted by router | Anthropic-compatible | Model discovery and provider failure parsing | Preserve |
| DockerLM | **compatible through existing local path; live Distpatch integration unverified** | Prefer `ollama` provider with DockerLM `/v1` base URL | No router credential required in current LAN posture | OpenAI Chat | `/v1/models` works; operational lifecycle exists separately | GPU/model loading/unload/resource state is not represented by generic provider semantics |
| Generic OpenAI-compatible | **fully supported for Chat surface** | `openai-compatible` | API key required | OpenAI Chat | Standard `/models` parser | No generic Responses surface; cannot represent credential-less endpoint |
| Generic Anthropic-compatible | **fully supported** | `anthropic-compatible` | API key required | Anthropic Messages | Standard listing/parser | Preserve |

## Current declared provider IDs

The pinned source declares:

`anthropic-oauth`, `anthropic-api`, `openai-oauth`, `openai-api`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `groq`, `deepseek`, `xai`, `mistral`, `together`, `cerebras`, `ollama`, `openai-compatible`, `anthropic-compatible`.

## Required provider work after M0

### Verify rather than build first

- **NVIDIA:** hosted API is OpenAI-compatible at `/v1/chat/completions`. Start with the generic driver and add a dedicated driver only if provider-specific error/quota/model semantics materially improve routing.
- **OpenCode Zen:** verify Chat-completions models with the generic driver. Responses-only Zen models expose a real gap: current generic compatibility only supports OpenAI Chat.
- **DockerLM:** use `ollama` as the initial transport because it permits credential-less OpenAI Chat endpoints and preserves a distinct local provider identity.

### New integration required

- **Antigravity:** dedicated official-CLI execution adapter or generalized CLI transport.
- **Vertex:** official ADC/service-account-aware integration if Vertex is required as a Distpatch target.
