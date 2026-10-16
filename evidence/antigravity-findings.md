# Antigravity M0 findings

## Verdict

**Missing from pinned upstream; technically feasible through an official CLI adapter. Do not implement through copied credentials by default.**

Existing `gemini` support is the Gemini API OpenAI-compatibility surface and is not Antigravity.

## Recommended boundary

Use the official `agy` CLI/keyring as credential owner. Headless stream-json can provide conversation IDs, tool/response events and token/cache usage; `agy models` provides discovery; `/usage` provides quota visibility from the CLI perspective; explicit conversation IDs support affinity/resume.

## Gating question

Multi-account isolation is not yet proven by authoritative documentation. Before implementation, demonstrate a supported named profile/credential root or isolate identities at the OS-user/container/keyring boundary. Do not assume a Claude-style config-dir mechanism exists.

## Quota

Treat CLI `/usage` as useful evidence, but do not claim a stable machine-readable quota API until one is documented or verified. Per-turn token/cache usage is a local ledger, not provider headroom. Unknown quota remains unknown.

## Implementation shape

```text
selected Antigravity model
  -> existing account selection
  -> Antigravity CLI servable candidate
  -> agy stream-json process/session
  -> common AttemptOutcome / health / usage pipeline
```

CLIProxyAPI is a strong code/protocol reference for Antigravity behavior, model discovery and error cases, but its router-owned OAuth/internal-endpoint design should not automatically become Distpatch's security boundary.