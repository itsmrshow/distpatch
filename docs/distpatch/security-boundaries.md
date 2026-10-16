# Distpatch security boundaries

M0 audit baseline: `developerz-ai/multi-ai-router@6d30948d560b4df2dab56be31879c143ddb24223` (v2.39.2).

## Credential boundaries

| Credential class | Current providers | Owner / storage | Refresh owner |
|---|---|---|---|
| API key | Anthropic API, OpenAI API, OpenRouter, z.ai, Kimi, MiniMax, Gemini, Groq, DeepSeek, xAI, Mistral, Together, Cerebras, compatible endpoints | router-managed encrypted credential envelope in PostgreSQL | operator |
| Router-managed OAuth | OpenAI / ChatGPT Codex subscription | router stores encrypted access/refresh material and provider identity | router OAuth refresh service |
| Official client-owned subscription state | Claude subscription | per-account `CLAUDE_CONFIG_DIR` | Claude CLI / Agent SDK |
| Credential-less local endpoint | Ollama / local compatible targets | no credential required; optional bearer if configured | N/A |

Router-managed secrets use AES-256-GCM and must remain outside response/log surfaces.

## Claude subscription

The default path remains the Claude Agent SDK. The CLI/SDK owns login and refresh, model listing comes from the SDK handshake, quota alarms come from `rate_limit_event`, and continuous plan usage comes from the SDK query object's structured usage method.

Current upstream also contains an **opt-in direct Claude HTTP fast mode**. `CLAUDE_FAST_MODE` defaults off. When explicitly enabled on a verified runtime, it may read only the selected account's credential under the ownership fence and perform inference directly, while login/refresh remains CLI/SDK-owned. M0 does not enable or modify this path. Any Distpatch change here requires explicit security review.

## OpenAI / Codex subscription

`openai-oauth` is different from Claude. The router owns the OAuth/PKCE/device flow, encrypted token storage, refresh, ChatGPT account identity, and Codex Responses request path. Do not generalize Claude's credential model onto this path without review.

## Antigravity direction

Antigravity is absent from upstream. Preferred future boundary is the official `agy` CLI/keyring rather than copying Google OAuth tokens into router storage. Before implementation, prove supported multi-account credential isolation. If the CLI cannot isolate profiles safely, isolate accounts at OS-user/container/keyring boundaries.

CLIProxyAPI is useful as a protocol/test reference but should not define the default credential architecture because it owns OAuth/token material and calls internal Google endpoints.

## DockerLM

DockerLM's current LAN `/v1` path does not require a Distpatch credential; nginx injects DockerLM's own downstream key. Do not confuse that internal provider credential with a Distpatch account credential.