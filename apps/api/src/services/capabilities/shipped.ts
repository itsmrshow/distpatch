import { CAPABILITY_SCHEMA_VERSION, type ShippedCatalogInput } from "./schema"

/**
 * The capability profiles shipped with the image (static bootstrap catalog).
 *
 * Deliberately sparse. A hard fact appears only when this repository already states it (the
 * shipped context-window table, live evidence) or the vendor documents it; every preference
 * score is **unknown** in the static bootstrap table. Preference scores enter at runtime through
 * the Capability Intelligence Pipeline (published snapshot layered over this bootstrap table) or
 * an explicit operator override (`MODEL_CAPABILITY_OVERRIDES_PATH`). Partial local calibration
 * runs (`evidence/capability-calibration-v1.md`) remain supplemental evidence, never hardcoded
 * as universal shipped rankings.
 *
 * Canonical ids are `vendor/model` and say nothing about which provider serves the model: the
 * same profile answers for Groq's `openai/gpt-oss-120b` and Cerebras's `gpt-oss-120b`. Aliases
 * are explicit, one hop, and never rewrite what goes upstream.
 *
 * Bump `revision` (`YYYY-MM-DD.N`) in the same commit as any edit below.
 */
export const SHIPPED_CAPABILITY_CATALOG: ShippedCatalogInput = {
  schemaVersion: CAPABILITY_SCHEMA_VERSION,
  revision: "2026-10-17.3",
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
      // (`cost/tables/groq.ts`, `together.ts`, `cerebras.ts`). Text and caller-defined function
      // calling exercised live during local evaluation; context window per the model card.
      id: "openai/gpt-oss-120b",
      family: "gpt-oss",
      aliases: ["gpt-oss-120b"],
      hard: {
        contextTokens: 131_072,
        textInput: true,
        textOutput: true,
        toolUse: true,
      },
      sources: [
        "repo:apps/api/src/services/cost/tables/groq.ts",
        "https://huggingface.co/openai/gpt-oss-120b",
        "repo:evidence/capability-calibration-v1.md",
      ],
    },
    // ---- Local fleet --------------------------------------------------------------------------
    // Semantic identity only. Which quant, runtime, context window and route alias serve each model
    // is route/artifact metadata (`evidence/model-inventory/dockerlm.json`, `inventory.ts`), never
    // the profile. Canonical ids are the lowercased Hugging Face repository id; exact HF casing
    // lives in `sources`. Catalog aliases are the route names the local host exposes, so a
    // candidate named by its route resolves to its semantic profile; they never rewrite upstream.
    // A derivative keeps its own profile and names its `baseModel`; it inherits no scores.
    // Preference scores stay unknown here; AA evidence compiles in only for exact public matches.
    {
      // Served as an ATX-IQ4_XS-M quant: the quant does not make it a different model.
      id: "qwen/qwen3.8-27b",
      family: "qwen",
      aliases: ["qwen3.8-27b"],
      tags: ["local"],
      hard: { textInput: true, textOutput: true, imageInput: true },
      sources: [
        "https://huggingface.co/Qwen/Qwen3.8-27B",
        "https://artificialanalysis.ai/models/qwen3-8-27b",
      ],
    },
    {
      // Served through the Strata runtime as a GSQ-RCO IQ2_XS quant; semantically the public model.
      id: "qwen/qwen3.8-flash-next",
      family: "qwen",
      aliases: ["strata-qwen38-flash-next"],
      tags: ["local"],
      hard: { textInput: true, textOutput: true, imageInput: true },
      sources: [
        "https://huggingface.co/Qwen/Qwen3.8-Flash-Next",
        "https://artificialanalysis.ai/models/qwen3-8-flash-next",
      ],
    },
    {
      // Fine-tune of Qwen3.5-9B. Text, forced/streamed function calls and JSON schema tested live
      // (M1); vision declared by the model card, not yet exercised through the router.
      id: "xiaomimimo/mimo-v2.6-distill-qwen-9b",
      family: "mimo",
      baseModel: "qwen/qwen3.5-9b",
      aliases: ["mimo-v2.6-distill-9b"],
      tags: ["local"],
      hard: {
        textInput: true,
        textOutput: true,
        imageInput: true,
        toolUse: true,
        structuredOutput: true,
      },
      sources: [
        "https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B",
        "repo:docs/distpatch/provider-matrix.md",
        "repo:evidence/m1a-generic-provider-closure.md",
      ],
    },
    {
      // Heretic/abliterated fine-tune of Qwen3.8-27B: a distinct model, not the base.
      id: "0bserverx/qwen3.8-27b-heretic-abliterated-uncensored",
      family: "qwen",
      baseModel: "qwen/qwen3.8-27b",
      aliases: ["qwen3.8-27b-rvn"],
      tags: ["local"],
      hard: { textInput: true, textOutput: true },
      sources: [
        "https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored",
        "https://huggingface.co/Qwen/Qwen3.8-27B",
      ],
    },
    {
      // APEX abliterated fine-tune of Qwen3.6-35B-A3B: a distinct model, not the base.
      id: "isvalorum/qwen3.6-35b-a3b-mtp-apex-i-miniplus-v2.1-abliterated",
      family: "qwen",
      baseModel: "qwen/qwen3.6-35b-a3b",
      aliases: ["qwen36-35b-apex-v21"],
      tags: ["local"],
      hard: { textInput: true, textOutput: true },
      sources: [
        "https://huggingface.co/IsValorum/Qwen3.6-35B-A3B-MTP-APEX-I-MiniPlus-V2.1-Abliterated",
        "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
      ],
    },
    {
      // Embedding-only: takes text, emits vectors, never text. Tagged `embedding`; the generative
      // virtual models refuse it through `hard.textOutput`, not through any special case.
      id: "qwen/qwen3-embedding-0.6b",
      family: "qwen-embedding",
      baseModel: "qwen/qwen3-0.6b-base",
      aliases: ["qwen3-embedding-0.6b"],
      tags: ["embedding", "local"],
      hard: {
        textInput: true,
        textOutput: false,
        imageInput: false,
        toolUse: false,
        structuredOutput: false,
      },
      sources: ["https://huggingface.co/Qwen/Qwen3-Embedding-0.6B"],
    },
  ],
}
