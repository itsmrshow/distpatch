import { disableThinkingForForcedTool } from "./body/forced-tool-thinking"
import { rewriteModel } from "./body/read"
import type { ChainContext } from "./chain"
import { modelOutputCeiling } from "./model-output-ceiling"
import type { ServableCandidate } from "./plan"

/**
 * The body this account gets. Passthrough: identical bytes, unless the wire model differs from the
 * name the bytes carry — the account's alias map, a stripped context tag (`routing/context-tag.ts`),
 * or a virtual model (`auto-task`) resolved to a concrete one — the one edit a
 * passthrough body ever receives, plus `thinking: disabled` beside a forced tool choice for a vendor
 * that thinks by default. Translate: rebuilt field by field,
 * which a Claude subscription also takes since the SDK's prompt is built from Anthropic-shaped
 * bytes either way.
 *
 * @throws TranslationError when a translated body has a field with no target representation.
 */
export function bodyFor(ctx: ChainContext, servable: ServableCandidate): Uint8Array | null {
  const pair = servable.translation
  if (pair !== null) {
    return ctx.translated.bodyFor(
      pair,
      servable.upstreamModel,
      servable.chatCeiling,
      pair.egress === "anthropic"
        ? modelOutputCeiling(
            ctx.modelMetadata,
            servable.candidate.account.id,
            servable.upstreamModel,
          )
        : undefined,
      servable.responsesEgress,
    )
  }
  if (ctx.bodyBytes.length === 0) return null
  // Compared against the name **in the bytes** (the requested one), never the selected one: a
  // virtual request whose selected and upstream names agree still carries `auto-*` in its body.
  const named =
    ctx.modelSpan === null || servable.upstreamModel === ctx.runtime.requestedModel
      ? ctx.bodyBytes
      : rewriteModel(ctx.bodyBytes, ctx.modelSpan, servable.upstreamModel)
  // The second passthrough edit: a vendor that thinks by default ignores a forced tool unless the
  // body states thinking off (`body/forced-tool-thinking.ts`). Real Anthropic is never asked.
  if (servable.kind === "http" && servable.driver.thinkingOnByDefault?.(servable.account.driver)) {
    return disableThinkingForForcedTool(named)
  }
  return named
}
