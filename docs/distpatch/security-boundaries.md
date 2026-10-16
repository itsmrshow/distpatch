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

**M1C result (2026-10-16): BLOCKED — tested live on `agy` 1.2.14 → 1.4.0.** See [M1C evidence](../../evidence/m1c-antigravity-isolation.md). The CLI self-updated in the background mid-session; 1.4.0's help/subcommand/flag surface was re-verified directly in an isolated `HOME`, with no authentication and no logout. The intended boundary holds in one direction — the CLI does own login and refresh, and nothing was copied into Distpatch — but it fails in the other:

- **No supported isolation selector found in the tested version.** No flag, subcommand, or honored environment variable selects a credential root. `AGY_ACCOUNT` selects *plugin* accounts (documented in-binary for sandboxed plugin CLIs such as `gh`), not the model-serving identity. `ANTIGRAVITY_CONFIG_REL_DIR` is not honored as an override.
- **The credential is single-slot.** `~/.gemini/antigravity-cli/antigravity-oauth-token` holds exactly one token object (`access_token`, `refresh_token`, `expiry`) at mode `0600`; sign-in replaces prior credentials rather than adding an account. Two sequential logins are not isolation.
- **Keyring is compiled in but absent at runtime on the reference host.** Go's `go_keyring` path exists, yet with no secret service the CLI falls back to a plaintext-at-rest 0600 token file. Any future deployment must treat that file as a secret at rest.
- **Container and OS-user isolation are unproven, not disproven.** Neither was tested. Either could preserve CLI-owned credentials without token copying, but each needs a second real account and explicit security review first. Selecting an identity by OS user would make the router's privilege boundary the actual security boundary — a materially different and more dangerous posture than the Claude `CLAUDE_CONFIG_DIR` model.
- **No adapter was implemented.** No `antigravity` ProviderId, subprocess driver, schema change, OAuth work, or model-routing code was added, and the boundary was not weakened to make progress.

Two conditions must both become true before M1C can resume: a **second operator-authorized Antigravity identity**, and an isolation design that is either supported by the CLI or explicitly security-reviewed (per-OS-user or per-container).

## DockerLM

DockerLM's current LAN `/v1` path does not require a Distpatch credential; nginx injects DockerLM's own downstream key. Do not confuse that internal provider credential with a Distpatch account credential.