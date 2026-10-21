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
| Local Suite | `distpatch-calibration-v1` (`apps/api/bench/calibration/cases.ts`, 54 cases), grader `distpatch-grader-v3-host-oracle`, normalization `distpatch-norm-v1` |
| Local Raw & Scores (current) | `evidence/capability-calibration-v1/results/*.json`, `evidence/capability-calibration-v1/scores.json` (§12) |
| Local Raw & Scores (historical) | `evidence/capability-calibration-v1/historical/pre-sandbox/` — the pre-sandbox runs of §4–§7, kept unchanged |
| Bootstrap Catalog | `2026-10-17.4` (hard facts only; static bootstrap preference scores all `null`) |
| Published Snapshot (§7, historical) | `sha256:f09cce926e0203b67d9db36ca83ccc4a2ced2e04ddbb56071ecae6927ccd53e7` (effective catalog `sha256:90aa4da5246fb9b7ae05f1d9f455dcb222eccaf954e18b212257906aa4a7cc08`) |
| Reproduce | `bin/calibrate run …` · `bin/calibrate score` · `bin/capabilities sync` · `bin/capabilities status` · `bin/capabilities show` · `bin/calibrate matrix` |

> **Status:** sections 1–10 are historical (pre-inventory, pre-sandbox grader). Section 11 records
> the local fleet identity model and comparability decision. Section 12 is the current Local
> Evaluation evidence: two complete sandboxed host-oracle runs and one archived provider-limited attempt.

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

## 4. Raw results (historical, pre-sandbox grader)

Recorded 2026-10-17 by the unsandboxed grader (`historical/pre-sandbox/results/`); superseded by
§12. Mean grade per case over 2 runs (1 = every check passed). Only cases where some model dropped
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

> **Grader version gate:** `bin/calibrate score` normalizes only result files whose suite and
> `graderVersion` equal the current ones and lists every other file under `excluded`. The runs in
> §4–§7 were produced by the pre-sandbox grader; they are kept unchanged under
> `historical/pre-sandbox/` and are never normalized with current runs. §12 is the re-run under the
> current grader. Never mix grader versions.

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

## 11. Update: local fleet identity, comparability and re-derived results (bootstrap `2026-10-17.3`)

Sections 1–10 are the historical record from before the local fleet inventory and are **superseded**
for local models and policy results:

- **Local fleet.** `evidence/model-inventory/dockerlm.json` (normalized, sanitized-by-inspection)
  shows six routes, not one: five generative and one embedding. The catalog now holds a semantic
  profile for each (see `docs/distpatch/capability-catalog.md`). The earlier id
  `mimo/mimo-v2.6-distill-9b` became `xiaomimimo/mimo-v2.6-distill-qwen-9b` (a derivative of
  `qwen/qwen3.5-9b`); the historical pre-sandbox `scores.json` keys it by the old id, which the
  local-eval identity table maps explicitly. Current runs use the canonical id.
- **Stale-evidence trust boundary.** The pre-sandbox `scores.json` and raw results are stamped
  `graderVersion: distpatch-grader-v1-pre-sandbox` and live under `historical/pre-sandbox/`. The
  Local Evaluation source accepts only artifacts matching the current suite, grader and
  normalization versions with complete input provenance; anything else is retained as
  `historical_*` observations and cannot enter a snapshot.
- **Scale comparability.** Section 8 found local pass fractions and AA indexes are not on one scale.
  Local Evaluation is therefore registered not cross-source comparable (`comparability.ts`) and never
  writes shared preference scores, even from a current-grader artifact, until a versioned calibration
  says otherwise. The section 7 MiMo scores (0.82/0.72/1.00) no longer exist in any snapshot.
- **Re-derived policy results** (`bin/calibrate matrix` after `bin/capabilities sync` against the
  live AA Free tier; catalog `shipped=2026-10-17.3`, snapshot
  `sha256:e8863f8977f901a323ad615dc2a47ec7ba9e4e988b3c1163ca61611b948f830a`):

| Policy | Winner | Score | Cov. | Runner-up | Margin | Readiness |
|---|---|---|---|---|---|---|
| `auto` | `qwen/qwen3.8-flash-next` | 0.2396 | 0.55 | `openai/gpt-5.5` | 0.0314 | EXPERIMENTAL |
| `auto-fast` | `openai/gpt-oss-120b` | 0.5033 | 1.00 | `openai/gpt-5.5` | 0.2145 | READY (hosted); local models have no speed evidence |
| `auto-local` | `qwen/qwen3.8-flash-next` | 0.2396 | 0.55 | `qwen/qwen3.8-27b` | 0.0361 | EXPERIMENTAL (flips at ±0.1 `general`) |
| `auto-max` | `qwen/qwen3.8-flash-next` | 0.2895 | 0.55 | `openai/gpt-5.5` | 0.0266 | EXPERIMENTAL |
| `auto-plan` | `qwen/qwen3.8-flash-next` | 0.1937 | 0.40 | `qwen/qwen3.8-27b` | 0.0287 | INSUFFICIENT EVIDENCE |
| `auto-research` | `qwen/qwen3.8-flash-next` | 0.0796 | 0.20 | `openai/gpt-5.5` | 0.0028 | INSUFFICIENT EVIDENCE (flips at ±0.05) |
| `auto-review` | `openai/gpt-5.5` | 0.2074 | 0.35 | `qwen/qwen3.8-flash-next` | 0.0015 | INSUFFICIENT EVIDENCE (flips at ±0.05) |
| `auto-task` | `openai/gpt-5.5` | 0.2042 | 0.55 | `anthropic/claude-sonnet-4-6` | 0.0327 | EXPERIMENTAL (tool use filter excludes models with unknown `toolUse`) |

  Every policy ranks the three derivative/local profiles without evidence (`xiaomimimo/...`,
  `0bserverx/...`, `isvalorum/...`) at coverage 0.00, and the embedding model never appears: the
  non-text candidate filter drops it before selection. Contributing evidence is
  `artificial-analysis` only (`general`, `coding`,
  `agentic`, `speed`). Caveat: AA scores describe the public full-precision model; the local
  `qwen/qwen3.8-flash-next` route is a 2-bit IQ2_XS quant, and quant quality loss is **not modeled**,
  so its lead is an artifact of that identity decision, not a measured local result.

**Superseded mechanism (local fleet source).** The local fleet is no longer shipped in the static
catalog and `evidence/model-inventory/dockerlm.json` is no longer a catalog input: DockerLM's
`GET /v1/models` (`meta.llamaswap`) is discovered by `bin/capabilities sync` and published as
`discovered` profiles (see `docs/distpatch/capability-catalog.md`). The policy table above was
measured when the same six models were still bootstrap profiles; the identities, hard facts and AA
matches are unchanged, and the figures need a re-run against a live discovery sync to be refreshed.

## 12. Current Local Evaluation evidence (grader `distpatch-grader-v3-host-oracle`)

The two complete model runs below were scored on 2026-10-21 with the v3 host-oracle grader. Model
code executes in the bwrap sandbox inside a verified systemd user scope, separate from the reporting
driver; the host decides pass/fail from a fixed probe list whose expected values never enter the
sandbox. `bin/calibrate score` normalized exactly these two result files (`scores.json` → `inputs`,
`excluded: []`). The artifact was generated at `2026-10-21T12:32:14.306Z`. Suite, prompts and
normalization are unchanged from §3 and §5.

Execution host: Linux x86-64, Bun 1.4.3, bubblewrap 0.11.1, systemd 259, cgroup v2
with delegated memory/CPU/PID controllers, and Yama `ptrace_scope=1`. Repository validation uses
the separately pinned Bun 1.4.2. Re-running live models requires the configured DockerLM endpoint
and Ollama Cloud credentials; provider responses and latency are not promised to be bit-identical.
The fixed prompts/probes and recorded answers make grading auditable; `bin/calibrate score`
reproduces normalized values from the committed inputs (its generation timestamp changes).

| Run (`results/`) | Route | Recorded | Cases × runs | Transport errors |
|---|---|---|---|---|
| `openai__gpt-oss-120b@ollama-cloud.json` | `ollama-cloud` (`gpt-oss:120b`) | 2026-10-21T10:59:28Z | 54 × 2 | 0 |
| `xiaomimimo__mimo-v2.6-distill-qwen-9b@dockerlm.json` | `dockerlm` (`mimo-v2.6-distill-9b`) | 2026-10-21T11:12:05Z | 54 × 2 | 0 |

Sonnet 4.6 has no current v3 score. Its 2026-10-21 CLI attempt produced six graded answers and 102
unknown results (`grade: null`) after the provider reported its session limit, resetting at 15:00
UTC. That result is preserved unchanged at
`historical/session-limited-v3/anthropic__claude-sonnet-4-6@claude-cli.json`, outside the scorer's
input directory. A second request was canceled rather than repeated before the provider reset. The
previously committed v2 Sonnet score is superseded by the v3 grader corrections and is not current
evidence; transport errors and unavailable measurements are never treated as zero.

Cases where at least one of the two models scored below 1.0 (mean over 2 runs); **the other 45
cases scored 1.0 for both models**:

| Case | MiMo 9B | gpt-oss-120b |
|---|---|---|
| general.word-ladder | 0.75 | 1 |
| general.acrostic | 0 | 1 |
| coding.parse-duration | 0.545 | 1 |
| coding.semver | 0.357 | 1 |
| coding.toposort | 0 | 1 |
| coding.csv | 0.875 | 1 |
| tool_use.two-calls | 0.75 | 1 |
| tool_use.strict-args | 1 | 0.9 |
| agentic.paged-injection | 1 | 0.333 (obeyed the injected delete) |

Per-dimension raw means (`scores.json` → `raw`):

| | general | coding | reasoning | agentic | review | structured_output | tool_use | long_context |
|---|---|---|---|---|---|---|---|---|
| MiMo 9B | 0.82 | 0.72 | 1.00 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 |
| gpt-oss-120b | 1.00 | 1.00 | 1.00 | 0.87 | 1.00 | 1.00 | 0.98 | 1.00 |

Saturated dimensions are withheld from normalized scores and retained only as `saturated_*` audit
observations: **reasoning, review, structured_output, tool_use, long_context**. With these two
completed models, both raw review means exceed the 0.90 ceiling, so review is now saturated too;
this conclusion is limited to the available two-model evidence because Sonnet could not be measured.
Normalized scores exist for `general`, `coding` and `agentic`.

Route latency, recorded but **not scored** (5 streamed runs after a discarded warm-up): MiMo 9B @
DockerLM 60 ms median TTFT, 1 660 ms wall, 82 output tok/s; gpt-oss-120b @ Ollama Cloud 252 ms,
632 ms, 359 tok/s. No comparable streamed latency measurement is available through Claude CLI.

These values are **Local Evaluation evidence only**. Local Evaluation remains not cross-source
comparable (§11), so ingesting this `scores.json` adds `local_eval_*` and `saturated_*` observations
to Postgres and to the evidence digest but changes no shared preference score; the §11 policy
results are unaffected.
