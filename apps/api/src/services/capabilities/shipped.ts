import { CAPABILITY_SCHEMA_VERSION, type ShippedCatalogInput } from "./schema"

/**
 * The capability profiles shipped with the image.
 *
 * Deliberately sparse. A hard fact appears only when this repository already states it (the
 * shipped context-window table, live evidence) or the vendor documents it. A preference score
 * appears only when the calibration gate published it: `distpatch-calibration-v1` suite,
 * `distpatch-norm-v1` normalization, every value copied verbatim from
 * `evidence/capability-calibration-v1/scores.json` and explained per model × dimension in
 * `evidence/capability-calibration-v1.md`. Everything else stays **unknown** — dimensions the
 * suite could not tell models apart on (reasoning, review, structured output, tool use, long
 * context), dimensions it does not measure (vision, speed, cost), and models it could not reach
 * (`openai/gpt-5.5`). No score here is a guess dressed as a measurement.
 *
 * Canonical ids are `vendor/model` and say nothing about which provider serves the model: the
 * same profile answers for Groq's `openai/gpt-oss-120b` and Cerebras's `gpt-oss-120b`. Aliases
 * are explicit, one hop, and never rewrite what goes upstream.
 *
 * Bump `revision` (`YYYY-MM-DD.N`) in the same commit as any edit below.
 */
export const SHIPPED_CAPABILITY_CATALOG: ShippedCatalogInput = {
  schemaVersion: CAPABILITY_SCHEMA_VERSION,
  revision: "2026-10-17.1",
  profiles: [
    {
      // Hosted first-party. Sizes mirror `models/windows/anthropic.ts`. Calibrated through the
      // Claude Code CLI (tools via a per-case MCP server).
      id: "anthropic/claude-sonnet-4-6",
      family: "claude-sonnet",
      aliases: ["claude-sonnet-4-6"],
      hard: {
        contextTokens: 1_000_000,
        maxOutputTokens: 128_000,
        textInput: true,
        textOutput: true,
        toolUse: true,
      },
      scores: { general: 1, coding: 0.95, agentic: 1 },
      sources: [
        "repo:apps/api/src/services/models/windows/anthropic.ts",
        "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
        "repo:evidence/capability-calibration-v1.md",
      ],
    },
    {
      // Hosted first-party. Sizes mirror `models/windows/openai.ts`. Not calibrated: no route
      // reachable from the calibration host served it, so every score stays unknown.
      id: "openai/gpt-5.5",
      family: "gpt-5",
      aliases: ["gpt-5.5"],
      hard: {
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        textInput: true,
        textOutput: true,
        toolUse: true,
      },
      sources: [
        "repo:apps/api/src/services/models/windows/openai.ts",
        "https://platform.openai.com/docs/guides/function-calling",
      ],
    },
    {
      // Open weights served by several OpenAI-compatible hosts under different wire ids
      // (`cost/tables/groq.ts`, `together.ts`, `cerebras.ts`). Calibrated through Ollama Cloud;
      // text and caller-defined function calling exercised live there. Context per the model card.
      id: "openai/gpt-oss-120b",
      family: "gpt-oss",
      aliases: ["gpt-oss-120b"],
      hard: {
        contextTokens: 131_072,
        textInput: true,
        textOutput: true,
        toolUse: true,
      },
      scores: { general: 0.99, coding: 1, agentic: 0.82 },
      sources: [
        "repo:apps/api/src/services/cost/tables/groq.ts",
        "https://huggingface.co/openai/gpt-oss-120b",
        "repo:evidence/capability-calibration-v1.md",
      ],
    },
    {
      // The M1 DockerLM model: text, forced/streamed function calls and JSON schema tested live;
      // vision deferred, so unknown. Context size was not measured. Calibrated on DockerLM.
      id: "mimo/mimo-v2.6-distill-9b",
      family: "mimo",
      aliases: ["mimo-v2.6-distill-9b"],
      tags: ["dockerlm", "free", "local"],
      hard: {
        textInput: true,
        textOutput: true,
        toolUse: true,
        structuredOutput: true,
      },
      scores: { general: 0.82, coding: 0.72, agentic: 1 },
      sources: [
        "repo:docs/distpatch/provider-matrix.md",
        "repo:evidence/m1a-generic-provider-closure.md",
        "repo:evidence/capability-calibration-v1.md",
      ],
    },
  ],
}
