# DockerLM M0 findings

## Verdict

**No dedicated `dockerlm` provider driver is required for basic inference in M1.**

DockerLM exposes OpenAI-style `/v1/models` and `/v1/chat/completions`. Its current LAN ingress does not require a Distpatch bearer token, so the closest existing upstream transport is `ollama`: OpenAI Chat shape, operator-supplied base URL, `authKind:none`, distinct local/self-hosted identity.

`openai-compatible` can speak the wire protocol but currently requires a key, making it less natural for the current DockerLM LAN posture.

## M1 recommendation

1. Configure/test DockerLM through `ollama` with its `/v1` base URL.
2. Add semantic tags such as `local`, `free`, and `dockerlm` independently of provider transport identity.
3. Verify model listing, streaming, tools, cancellation and unavailable/unloaded-model behavior.
4. Add a dedicated lifecycle/resource adapter only if GPU occupancy, model loading/unloading or worker state materially improves routing and cannot be represented cleanly as optional state.