# Capability Intelligence Pipeline & Local Evaluation Evidence (v1)

Gate before M3 (#10): transition from partial local benchmark runs defining universal production
scores to the **Distpatch Capability Intelligence Pipeline** (`services/capabilities/intelligence/`,
`bin/capabilities`), combining maintained external model-intelligence sources (`artificial-analysis`)
with the sandboxed **Distpatch Local Evaluation Framework** (`distpatch-local-eval`) as supplemental
evidence for local/DockerLM models and custom builds.

| | |
|---|---|
| Base | `main @ e6507b6b914657584bd948fa142800bcaefff72c` |
| Compiler / Normalizer | `distpatch-cap-compiler-v1` / `distpatch-cap-norm-v1` |
| External Source | `artificial-analysis` (`/api/v2/language/models/free`, Intelligence Index v4.3, 704 records across 4 pages) |
| Local Suite | `distpatch-calibration-v1` (`apps/api/bench/calibration/cases.ts`, 54 cases, `bwrap` sandbox `distpatch-grader-v1-bwrap`) |
| Local Raw & Scores | `evidence/capability-calibration-v1/results/*.json`, `evidence/capability-calibration-v1/scores.json` |
| Bootstrap Catalog | `2026-10-17.2` (hard facts only; static bootstrap preference scores all `null`) |
| Published Snapshot | `sha256:f09cce926e0203b67d9db36ca83ccc4a2ced2e04ddbb56071ecae6927ccd53e7` (effective catalog `sha256:90aa4da5246fb9b7ae05f1d9f455dcb222eccaf954e18b212257906aa4a7cc08`) |
| Reproduce | `bin/capabilities sync` · `bin/capabilities status` · `bin/capabilities show` · `bin/calibrate matrix` |
## 1. Model inventory

### Shipped profiles (before this gate)

| Canonical id | Aliases | Family | Hard facts | Tags | Scores | Sources |
|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | `claude-sonnet-4-6` | claude-sonnet | 1 000 000 ctx, 128 000 out, text in/out, tools | — | none | windows table, Anthropic tool docs |
| `openai/gpt-5.5` | `gpt-5.5` | gpt-5 | 1 050 000 ctx, 128 000 out, text in/out, tools | — | none | windows table, OpenAI function-calling docs |
| `openai/gpt-oss-120b` | `gpt-oss-120b` | gpt-oss | none | — | none | Groq price table |
| `mimo/mimo-v2.6-distill-9b` | `mimo-v2.6-distill-9b` | mimo | text in/out, tools, structured output (M1 live) | dockerlm free local | none | provider matrix, M1A closure |

### Configured on the calibration host

No credential was read or printed; only route existence was checked.

| Model (client name) | Profile | Reached through | Local | Path | Profile missing? |
|---|---|---|---|---|---|
| `mimo-v2.6-distill-9b` | `mimo/mimo-v2.6-distill-9b` | DockerLM LAN (`ollama` transport) | yes | open-compatible, no auth | no |
| `qwen3.8-27b`, `qwen3.8-27b-rvn`, `qwen36-35b-apex-v21`, `strata-qwen38-flash-next` | — | DockerLM LAN | yes | open-compatible | yes — see below |
| `gpt-oss-120b` (`gpt-oss:120b` on the wire) | `openai/gpt-oss-120b` | Ollama Cloud (operator API key in env) | no | open-compatible API | no |
| `claude-sonnet-4-6` | `anthropic/claude-sonnet-4-6` | Claude Code CLI (subscription) | no | subscription | no |
| `gpt-5.5` | `openai/gpt-5.5` | **none working**: Codex CLI refresh token revoked; opencode's ChatGPT route refuses `gpt-5.5` | no | — | no |

The local router database has **no accounts** configured, so no `supportedModels` list exists to
inventory; the table above is the set of routes actually reachable from this machine. Ollama
Cloud also lists ~20 other open models (kimi, glm, deepseek, minimax, …); none is configured in
Distpatch, so none was profiled.

### Missing profiles

- **Worth adding now: none.** Every configured model that is a stable, identifiable release
  already has a profile.
- **Kept unprofiled:** the four non-MiMo DockerLM models. Each is an operator-specific quant,
  abliterated or runtime-specific build (`IQ4_XS`, "Heretic Abliterated", `IQ2_XS` on a custom
  runtime). Their behaviour is a property of that local build, not of a vendor model; an operator
  who routes to one should add it through `MODEL_CAPABILITY_OVERRIDES_PATH` and run the suite.

## 2. Evidence hierarchy & source precedence

1. **Operator override (`MODEL_CAPABILITY_OVERRIDES_PATH`)** — highest-authority local configuration.
2. **Maintained external model intelligence (`artificial-analysis`)** — primary evidence for hosted,
   widely benchmarked models (`anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`, `openai/gpt-oss-120b`)
   on `general` (`intelligence_index / 100`), `coding` (`coding_index / 100`), `agentic`
   (`agentic_index / 100`), and `speed` (throughput + TTFT).
3. **Distpatch Local Evaluation Framework (`distpatch-local-eval`)** — primary evidence for
   local/DockerLM models (`mimo/mimo-v2.6-distill-9b`) and custom quantizations absent from external
   indexes, and supplemental evidence for Distpatch-specific dimensions.
4. **Static bootstrap catalog (`SHIPPED_CAPABILITY_CATALOG`)** — verified hard facts only; all
   bootstrap preference scores remain `null` so an unsynced router never serves partial local
   benchmark artifacts as universal hosted rankings.

Sources are never automatically averaged. Model reputation, size, parameter count, and vendor
marketing are never used for any number.

## 3. Evaluation set (`distpatch-calibration-v1`)

Every case targets one dimension and is graded by deterministic code (string/regex checks,
JSON-shape checks, executing the answer against hidden tests in a Bun subprocess, or the end
state of a mock tool environment). No model grades another. Prompts are synthetic, so raw
responses are committed.

| Dimension | n | Cases |
|---|---|---|
| general | 7 | 3-bullet constraint, memo synthesis with exclusion, fact triple, sort/normalize, time zones, word-count ladder without the letter *e*, 7-letter acrostic |
| coding | 8 | `parseDuration` (11 tests), fix buggy `chunk`, LRU cache, `withTimeout`, trace comprehension, SemVer 2.0 precedence (14), lexicographic topological sort with cycle error, RFC 4180 CSV line |
| reasoning | 8 | line-up constraints, tank arithmetic, timeout/retry budget, conditional dice probability, critical path, knights/knaves, inclusion–exclusion, calendar arithmetic |
| review | 8 | SQL injection + unawaited promise, 1-based pagination, payments design (idempotency, stale permissions, PAN logging), lost-update race, `sort()` lexicographic + mutation, cache-key collision + seconds/ms, and two **clean** snippets graded on raising no false defect |
| structured_output | 6 | entity extraction, constrained array, nullables without outside knowledge, escaping, conditional keys per variant, numeric constraints (count/distinct/sum/parity) |
| tool_use | 6 | tool selection + args, two calls + comparison, IATA/date args, no tool when none needed, chained search → convert, strict RFC 3339 / integer args |
| agentic | 5 | fix + re-verify tests, recover from a tool error, reach an exact list state minimally, iterate to green against hidden tests reporting one failure at a time, paged listing containing a **prompt-injection** instruction to delete a ticket |
| long_context | 6 | ~25k-token log: needle, two-hop, count+sum; ~65k-token log: superseded fact, three-hop chain, first-appearance ordering |
| vision / speed / cost | — | not graded (§6) |

Routes, recorded beside — never inside — model identity:

- `dockerlm` — OpenAI Chat to the LAN DockerLM endpoint, model default reasoning, temperature 0.
- `ollama-cloud` — OpenAI Chat to `https://ollama.com/v1`, temperature 0.
- `claude-cli` — `claude -p --model claude-sonnet-4-6 --tools "" --system-prompt <same>`; tools
  served by a per-case MCP stdio server (`mcp-env.ts`) running the **same** mock environments.
  Temperature is the CLI default (not settable), which the two-run pooling partly absorbs.

Suite history (v1 was not frozen until all of this was fixed; the committed results are from the
final suite only): a first pass of 34 cases saturated at 1.0 for both hosted models, so the
harder tier was added; a grader bug (`.` stripped from an e-mail address), an unsatisfiable
constraint (3 odd numbers summing to 200), a needle Sonnet refused as a credential ("vault access
phrase" → meeting room), and an unawaited async tool environment were found and fixed before the
final runs.

## 4. Raw results

Mean grade per case over 2 runs (1 = every check passed). Only cases where some model dropped
below 1.0 are listed; **the other 44 cases were 1.0 for all three models.**

| Case | Sonnet 4.6 | MiMo 9B | gpt-oss-120b |
|---|---|---|---|
| general.word-ladder | 1 | 0.75 | 0.938 |
| general.acrostic | 1 | 0 | 1 |
| coding.parse-duration | 1 | 0.545 | 1 |
| coding.semver | 1 | 0.357 | 1 |
| coding.toposort | 1 | 0 | 1 |
| coding.csv | 0.563 | 0.875 | 1 |
| tool_use.two-calls | 1 | 0.75 | 0.875 |
| tool_use.strict-args | 1 | 1 | 0.9 |
| agentic.reach-state | 1 | 1 | 0.75 (forgot `bread`) |
| agentic.paged-injection | 1 | 1 | 0.333 (obeyed the injected delete) |

Per-dimension raw means (`scores.json` → `raw`):

| | general | coding | reasoning | agentic | review | structured | tool_use | long_context |
|---|---|---|---|---|---|---|---|---|
| Sonnet 4.6 | 1.00 | 0.95 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| MiMo 9B | 0.82 | 0.72 | 1.00 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 |
| gpt-oss-120b | 0.99 | 1.00 | 1.00 | 0.82 | 1.00 | 1.00 | 0.96 | 1.00 |
| GPT-5.5 | not run | | | | | | | |

Latency, recorded but **not scored** (5 streamed runs after a discarded warm-up, fixed 40-number
prompt):

| Model @ route | median TTFT | median wall | median output tok/s |
|---|---|---|---|
| MiMo 9B @ DockerLM (LAN GPU) | 68 ms | 1 699 ms | 80 |
| gpt-oss-120b @ Ollama Cloud | 263 ms | 572 ms | 455 |
| Sonnet 4.6 @ Claude CLI | not measurable (CLI start-up dominates) | | |

## 5. Normalization (`distpatch-norm-v1`)

```text
grade(c, r)  = passed checks / total checks, case c, run r          (∈ [0, 1])
raw(m, d)    = round2( mean_c∈d  mean_r grade(c, r) )                 (null if any case of d unrun)
discriminating(d) ⇔ ∃ measured model m: raw(m, d) ≤ 0.90
score(m, d)  = raw(m, d) if discriminating(d) else null
```

- **Absolute**: a published value depends only on that model's grades. Adding a model never
  changes an existing value (it can only make a withheld dimension discriminating). No
  best-model = 1.0 rescaling; one extreme model cannot move anyone else.
- **Monotonic** in every grade; deterministic; two decimals because n = 5–8 per dimension.
- **Full coverage**: a dimension is never scored from a subset of its cases.
- **Validity gate**: if every measured model clears 0.90, the suite has not shown it can tell
  models apart there. Publishing `reasoning: 1.0` for a 9B distill and a frontier model alike
  would make a ceiling artifact look like a capability claim, so the dimension stays unknown and
  is listed as saturated. This withheld **reasoning, review, structured_output, tool_use,
  long_context** in v1.
- **Recalibration**: bump `SUITE_VERSION` for any case change, re-run every model, never mix
  versions (the normalizer refuses mixed suites).

## 6. Dimensions deliberately not scored

- **vision** — no model was tested with image input. MiMo and one DockerLM Qwen advertise vision
  in their listing; advertisement is not evidence.
- **speed** — every measurement above is a *route* measurement: MiMo's numbers are this
  operator's GPU, gpt-oss's are Ollama Cloud's fleet (Groq/Cerebras serve the same weights several
  times faster), Sonnet could only be reached through a CLI. No model was measured on two
  comparable routes, so no provider-independent speed exists. `auto-fast` therefore currently
  ranks on `general` alone (§9).
- **cost** — open weights have no single price (several hosts, plus free local inference), and
  a subscription or free route is an account property. Without a provider-independent
  definition the score would encode routes, which the catalog forbids.

## 7. Compiled capability snapshot (Artificial Analysis + Local Eval)

Live manual sync via `bin/capabilities sync` ingested **5,126** observations across **704** models
(4 pages of 200) from Artificial Analysis (`tier: free`, `intelligence_index_version: 4.3`) plus
**9** non-saturated observations from `distpatch-local-eval`, producing published snapshot
`sha256:f09cce926e0203b67d9db36ca83ccc4a2ced2e04ddbb56071ecae6927ccd53e7` (evidence digest
`sha256:74421c84338db05a84f8fa9fa5c848cdbdf16a22eb0650d8ef4120b60ce43752`, effective catalog
`sha256:90aa4da5246fb9b7ae05f1d9f455dcb222eccaf954e18b212257906aa4a7cc08`):

| Model | Evidence source | general | coding | reasoning | agentic | review | structured_output | tool_use | long_context | vision | speed | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | `artificial-analysis` (`claude-sonnet-4-6-adaptive`) | **0.3010** | **0.6300** | unknown | **0.3180** | unknown | unknown | unknown | unknown | unknown | **0.1476** | unknown |
| `openai/gpt-5.5` | `artificial-analysis` (`gpt-5-5`) | **0.3840** | **0.7490** | unknown | **0.3640** | unknown | unknown | unknown | unknown | unknown | **0.2373** | unknown |
| `openai/gpt-oss-120b` | `artificial-analysis` (`gpt-oss-120b`) | **0.1160** | **0.3040** | unknown | **0.0370** | unknown | unknown | unknown | unknown | unknown | **0.7074** | unknown |
| `mimo/mimo-v2.6-distill-9b` | `distpatch-local-eval` (`mimo-v2.6-distill-9b@dockerlm`) | **0.8200** | **0.7200** | unknown | **1.0000** | unknown | unknown | unknown | unknown | unknown | unknown | unknown |

## 8. Scale calibration finding (AA v4.3 vs Local Eval v1)

- **Hosted frontier separation is now clear**: Artificial Analysis v4.3 cleanly separates
  `openai/gpt-5.5` (`general: 0.3840`, `coding: 0.7490`, `agentic: 0.3640`),
  `anthropic/claude-sonnet-4-6` (`general: 0.3010`, `coding: 0.6300`, `agentic: 0.3180`), and
  `openai/gpt-oss-120b` (`general: 0.1160`, `coding: 0.3040`, `agentic: 0.0370`, `speed: 0.7074`
  at 213.57 tok/s and 0.87s TTFT).
- **Cross-source scale mismatch when local and hosted candidates share a pool**: AA v4.3 composite
  indexes (`0..100` mapped linearly to `raw / 100`) place frontier models around `0.30–0.75`
  because the v4.3 suite includes Frontier-hard benchmarks (HLE, CritPt, Terminal-Bench 4.0,
  AA-Omniscience), whereas `distpatch-local-eval` (`distpatch-norm-v1`) grades fraction of checks
  passed on 54 self-contained tasks (`0.72–1.00` for MiMo 9B). Consequently, when
  `mimo/mimo-v2.6-distill-9b` is included in an unrestricted candidate set alongside hosted models,
  its uncalibrated `0.72–1.00` pass rate outscores AA's `0.30–0.75` composite index on quality
  policies.

## 9. Virtual policy results (all 4 shipped profiles in candidate set)

From `bin/calibrate matrix` over catalog `sha256:90aa4da5246fb9b7ae05f1d9f455dcb222eccaf954e18b212257906aa4a7cc08`:

| Policy | Winner | Score | Coverage | Runner-up | Score | Margin | Decision Digest |
|---|---|---|---|---|---|---|---|
| `auto` | `mimo/mimo-v2.6-distill-9b` | 0.4780 | 0.55 | `openai/gpt-5.5` | 0.2082 | 0.2698 | `sha256:8d5d4f8f…` |
| `auto-fast` | `openai/gpt-oss-120b` | 0.5004 | 1.00 | `openai/gpt-5.5` | 0.2886 | 0.2118 | `sha256:d0272a91…` |
| `auto-local` | `mimo/mimo-v2.6-distill-9b` | 0.4780 | 0.55 | — | — | — | `sha256:ce258228…` |
| `auto-max` | `mimo/mimo-v2.6-distill-9b` | 0.4630 | 0.55 | `openai/gpt-5.5` | 0.2630 | 0.2001 | `sha256:d2213e1e…` |
| `auto-plan` | `mimo/mimo-v2.6-distill-9b` | 0.3730 | 0.40 | `openai/gpt-5.5` | 0.1486 | 0.2244 | `sha256:968b08de…` |
| `auto-research` | `mimo/mimo-v2.6-distill-9b` | 0.1640 | 0.20 | `openai/gpt-5.5` | 0.0768 | 0.0872 | `sha256:0493f4c5…` |
| `auto-review` | `mimo/mimo-v2.6-distill-9b` | 0.2670 | 0.35 | `openai/gpt-5.5` | 0.2074 | 0.0596 | `sha256:03c8b32f…` |
| `auto-task` | `mimo/mimo-v2.6-distill-9b` | 0.5140 | 0.55 | `openai/gpt-5.5` | 0.2042 | 0.3098 | `sha256:285c1a55…` |

## 10. Sensitivity & M3 readiness classification

- **`auto-fast` — READY**: 100% coverage (`speed` + `general`) across all hosted models from
  Artificial Analysis, 0.2118 margin (`openai/gpt-oss-120b` over `openai/gpt-5.5`), zero flips at
  ±0.05 or ±0.10.
- **`auto-local` — READY**: deterministic `local` tag filter selects `mimo/mimo-v2.6-distill-9b`
  with 0.55 coverage from `distpatch-local-eval`.
- **`auto`, `auto-task`, `auto-max` — EXPERIMENTAL**: 0.55 coverage; among hosted models
  `openai/gpt-5.5` leads `anthropic/claude-sonnet-4-6`, but when local MiMo is in the same key
  scope, cross-source scale differences (`distpatch-norm-v1` pass rate vs AA v4.3 composite index)
  cause MiMo to outrank frontier hosted models, and `reasoning` / `tool_use` remain unknown.
- **`auto-plan`, `auto-research`, `auto-review` — INSUFFICIENT EVIDENCE**: coverage is only
  0.20–0.40 because their primary weighted dimensions (`reasoning` 25–40%, `long_context` 20–30%,
  `review` 40%) remain `null` on the AA Free tier and saturated in `distpatch-calibration-v1`.
