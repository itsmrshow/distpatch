import { CAPABILITY_SCHEMA_VERSION, type ShippedCatalogInput } from "./schema"

/**
 * The capability profiles shipped with the image.
 *
 * Deliberately sparse. A hard fact appears only when this repository already states it (the
 * shipped context-window table, M1 live evidence) or the vendor documents it; every preference
 * score is **unknown** until a benchmark program measures it. No score here is a guess dressed as
 * a measurement — an empty column is the honest state, and a selector (#8) decides what unknown
 * means for eligibility.
 *
 * Canonical ids are `vendor/model` and say nothing about which provider serves the model: the
 * same profile answers for Groq's `openai/gpt-oss-120b` and Cerebras's `gpt-oss-120b`. Aliases
 * are explicit, one hop, and never rewrite what goes upstream.
 *
 * Bump `revision` (`YYYY-MM-DD.N`) in the same commit as any edit below.
 */
export const SHIPPED_CAPABILITY_CATALOG: ShippedCatalogInput = {
  schemaVersion: CAPABILITY_SCHEMA_VERSION,
  revision: "2026-10-16.1",
  profiles: [
    {
      // Hosted first-party. Sizes mirror `models/windows/anthropic.ts`.
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
      sources: [
        "repo:apps/api/src/services/models/windows/anthropic.ts",
        "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
      ],
    },
    {
      // Hosted first-party. Sizes mirror `models/windows/openai.ts`.
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
      // (`cost/tables/groq.ts`, `together.ts`, `cerebras.ts`). Nothing verified beyond identity:
      // the profile is intentionally all-unknown.
      id: "openai/gpt-oss-120b",
      family: "gpt-oss",
      aliases: ["gpt-oss-120b"],
      sources: ["repo:apps/api/src/services/cost/tables/groq.ts"],
    },
    {
      // The M1 DockerLM model: text, forced/streamed function calls and JSON schema tested live;
      // vision deferred, so unknown. Context size was not measured.
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
      sources: [
        "repo:docs/distpatch/provider-matrix.md",
        "repo:evidence/m1a-generic-provider-closure.md",
      ],
    },
  ],
}
