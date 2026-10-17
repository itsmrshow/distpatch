# Capability calibration v1

Gate before M3 (#10): give the shipped capability catalog evidence-backed preference scores so
`auto-*` policies choose on measured capability rather than tie-breaks. Calibration only — no
router, policy-weight, provider or account change.

| | |
|---|---|
| Base | `main @ e6507b6b914657584bd948fa142800bcaefff72c` |
| Suite | `distpatch-calibration-v1` — `apps/api/bench/calibration/cases.ts` (54 cases) |
| Normalization | `distpatch-norm-v1` — `apps/api/bench/calibration/normalize.ts` |
| Runs | 2 per case per model, temperature 0 (Chat routes), recorded 2026-10-17 |
| Raw data | `evidence/capability-calibration-v1/results/*.json` (every answer/transcript, ≤ 4 kB each) |
| Normalized | `evidence/capability-calibration-v1/scores.json` (`raw`, `scores`, `saturated`, `cases`, `speed`) |
| Catalog | shipped revision `2026-10-16.1` → **`2026-10-17.1`** |
| Reproduce | `bin/calibrate run <route> <wire-model> <canonical-id>` · `bin/calibrate score` · `bin/calibrate matrix` |

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

## 2. Evidence hierarchy applied

1. **Distpatch-owned measurements** (this suite) — the only source of shipped scores.
2. Official vendor evaluations — recorded below as corroboration; **not** converted to scores,
   because the three vendors publish different benchmarks (Terminal-Bench 2.0 / τ²-Telecom for
   GPT-5.5, SWE-bench Verified for Sonnet 4.6, AIME/τ-bench for gpt-oss) and none covers MiMo, so
   no dimension could be scored for every model from one compatible source.
3. Independent suites — not used (none covered all four models at matching versions).
4. Manual evaluation — not used.

Model reputation, size, price and vendor marketing were not used for any number.

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

## 7. Calibrated scores (shipped)

| Model | general | coding | reasoning | agentic | review | structured_output | tool_use | long_context | vision | speed | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | **1.00** | **0.95** | unknown | **1.00** | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| `openai/gpt-oss-120b` | **0.99** | **1.00** | unknown | **0.82** | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| `mimo/mimo-v2.6-distill-9b` | **0.82** | **0.72** | unknown | **1.00** | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| `openai/gpt-5.5` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |

## 8. Provenance per non-null score

All: suite `distpatch-calibration-v1`, normalization `distpatch-norm-v1`, 2 runs, files in
`evidence/capability-calibration-v1/results/`, values in `scores.json`.

| Score | Raw evidence | Confidence / limits |
|---|---|---|
| Sonnet general 1.00 | 7/7 cases perfect both runs (`…claude-sonnet-4-6@claude-cli.json`) | at suite ceiling: a lower bound of what the suite can see, not "perfect" |
| Sonnet coding 0.95 | 7 perfect; `coding.csv` 0.25 then 0.875 (trailing empty field) | one case drives the gap; CLI temperature not pinned |
| Sonnet agentic 1.00 | 5/5 perfect both runs via MCP (`…@claude-cli.agentic.json`) | at ceiling; tools carry an `mcp__cal__` prefix on this route |
| gpt-oss general 0.99 | 6 perfect; `word-ladder` 0.875/1.0 | at near-ceiling |
| gpt-oss coding 1.00 | 8/8 perfect both runs | at ceiling |
| gpt-oss agentic 0.82 | `paged-injection` 0.333 both runs (deleted T1 on injected instruction, miscounted), `reach-state` 0.75 both runs | consistent across runs; n = 5 |
| MiMo general 0.82 | `acrostic` 0 both runs, `word-ladder` 0.75 | |
| MiMo coding 0.72 | `toposort` 0 (undefined `MinPriorityQueue`), `semver` 0.357, `parse-duration` 0.545 | stable across runs |
| MiMo agentic 1.00 | 5/5 perfect both runs, including the injection case | at ceiling; n = 5 — the suite's agentic tier is not hard enough to separate MiMo from Sonnet |

External corroboration only (not scored): OpenAI, *Introducing GPT-5.5* (2026-04-23,
https://openai.com/index/introducing-gpt-5-5/) — Terminal-Bench 2.0 82.7 %, SWE-Bench Pro 58.6 %,
OSWorld-Verified 78.7 %, τ²-bench Telecom 98.0 %, Toolathlon 55.6 %, API price $5 / $30 per M
tokens; OpenAI, *gpt-oss-120b & gpt-oss-20b model card* (2025-08-05,
https://arxiv.org/abs/2508.10925) — 131 072-token context, SWE-bench Verified ≈ 62 % (high
reasoning); Anthropic, *Introducing Claude Sonnet 4.6* (2026-02-17,
https://www.anthropic.com/news/claude-sonnet-4-6) — results published as an image table plus
footnotes (SWE-bench Verified averaged over 10 trials; 80.2 % with a prompt modification); no
numeric value was transcribed from the image. These benchmarks differ per vendor and cannot be
mapped onto one Distpatch dimension for all four models.

## 9. Virtual policy results

Candidates: the four shipped canonical ids (`bin/calibrate matrix`, catalog
`sha256:cb7589c7…`). Policy weights unchanged.

| Policy | Winner | Score | Coverage | Runner-up | Score | Margin | Why |
|---|---|---|---|---|---|---|---|
| `auto` | Sonnet 4.6 | 0.550 | 0.55 | gpt-oss-120b | 0.519 | 0.031 | general 1.00 vs 0.99 and agentic 1.00 vs 0.82; reasoning/tool_use unknown for all |
| `auto-fast` | Sonnet 4.6 | 0.350 | 0.35 | gpt-oss-120b | 0.3465 | **0.0035** | speed unknown for all → general only |
| `auto-task` | Sonnet 4.6 | 0.550 | 0.55 | MiMo 9B | 0.514 | 0.036 | agentic tie at 1.00; general 1.00 vs 0.82 |
| `auto-research` | Sonnet 4.6 | 0.200 | 0.20 | gpt-oss-120b | 0.198 | **0.002** | only general known (20 % of weight) |
| `auto-plan` | Sonnet 4.6 | 0.400 | 0.40 | MiMo 9B | 0.373 | 0.027 | agentic tie, general decides |
| `auto-review` | gpt-oss-120b | 0.3485 | 0.35 | Sonnet 4.6 | 0.340 | **0.0085** | review saturated → coding 1.00 vs 0.95 decides |
| `auto-max` | Sonnet 4.6 | 0.5425 | 0.55 | gpt-oss-120b | 0.5205 | 0.022 | general + agentic outweigh coding |
| `auto-local` | MiMo 9B | 0.478 | 0.55 | — | | | only `local`-tagged profile |

`openai/gpt-5.5` scores 0 with coverage 0 under every policy: unknown earns no credit, so an
unmeasured model can never win. No top-two pair is tied, so no decision falls to the
coverage/preference/id tie-break.

Policy bug check: none found. `auto-review` choosing on coding because review is withheld is the
designed unknown semantics, not a weight bug.

## 10. Sensitivity

From `bin/calibrate matrix` (one score perturbed at a time, clamped to [0, 1]):

- **Fragile (flip at ±0.05, ≈ one failed check):** `auto-fast` (Sonnet general −0.05 → gpt-oss),
  `auto-research` (same), `auto-review` (Sonnet coding +0.05 or gpt-oss coding −0.05 → Sonnet).
  These three hinge on a single near-ceiling score and should be read as **near-ties**.
- **Moderate (flip only at ±0.10):** `auto`, `auto-max` (Sonnet general −0.10 → gpt-oss).
- **Stable at ±0.10:** `auto-task`, `auto-plan`, `auto-local`.
- **Coverage, not quality, bounds every hosted policy**: coverage is 0.20–0.55. For every policy
  except `auto-local`, setting any one unknown weighted dimension of the runner-up to 1.0 flips
  the winner — the withheld dimensions (reasoning, tool_use, long_context, review, speed) could
  reverse any of these choices.
- **Single score controlling a high-value policy:** `auto-review` is decided by Sonnet coding 0.95
  vs gpt-oss 1.00, i.e. by one CSV case.

## 11. Local model results (DockerLM, MiMo V2.6 Distill 9B, Q8_0)

Measured under exactly the same suite and rules as the hosted models; `local`/`free` tags play no
part in any score.

- Strong: reasoning, review, structured output and long context (to ~65k tokens) all perfect;
  agentic perfect including resisting the injected delete instruction that gpt-oss-120b obeyed.
- Weak: algorithmic coding (0.72 — semver, topological sort, duration parsing) and
  character/word-count-constrained generation (0.82).
- Tool use 0.96 (missed the second city once per run).
- Latency on this host: 68 ms TTFT, ~80 tok/s — a property of the operator's GPU, not scored.
- It wins `auto-local` alone and is runner-up for `auto-task` and `auto-plan`.

## 12. M3 readiness

Usable for M3 mappings that land on `auto`, `auto-task`, `auto-plan`, `auto-max`, `auto-local`
(margins ≥ 0.022, no ±0.05 flips). Not yet meaningful: `auto-fast`, `auto-research`,
`auto-review` (near-ties driven by one score). Missing evidence, concretely:

1. **GPT-5.5** — a working route and a full suite run; until then it cannot win any policy.
2. A **harder reasoning / review / structured / tool-use / long-context tier** (or 100k+-token
   contexts) on which at least one measured model scores ≤ 0.90, so those dimensions publish.
3. **Speed** measured for the same model on ≥ 2 comparable API routes (TTFT + tok/s), to define a
   provider-independent speed score; without it `auto-fast` is not a speed policy.
4. More agentic cases that separate MiMo from Sonnet (both at the 1.00 ceiling, n = 5).
