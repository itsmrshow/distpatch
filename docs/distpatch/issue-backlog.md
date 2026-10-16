# Distpatch issue backlog and dependency structure

GitHub Issues are enabled. The available connector does not expose milestone creation, so milestone identity is encoded in issue titles/bodies (`M1`…`M8`) and dependencies are expressed as issue references.

## M1 — provider closure

- #1 Antigravity CLI adapter investigation
- #2 DockerLM first-class local target
- #3 NVIDIA generic verification
- #4 OpenCode Zen / Responses gap
- #5 Vertex support decision
- #6 provider verification matrix, depends on #1–#5

## M2 — deterministic virtual model layer

- #7 unified capability catalog, depends on #6
- #8 deterministic model selection, depends on #7
- #9 virtual `auto-*` model resolution, depends on #7 and #8

## M3–M8

- #10 M3 OMP integration, depends on #9
- #11 M4 live usage/quota-aware semantic scoring, depends on #8 and #6
- #12 M5 Hermes integration, depends on #9 and #10
- #13 M6 optional JEV/local classifiers, depends on #8
- #14 M7 context engine, depends on #9
- #15 M8 Auto-MoE, depends on #9 and #11 plus evaluation benchmarks

No issue represents implemented work unless its acceptance criteria have actually been satisfied.