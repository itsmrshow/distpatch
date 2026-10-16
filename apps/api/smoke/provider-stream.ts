import { z } from "zod"

const call = z.looseObject({
  index: z.number().default(0),
  function: z.looseObject({ name: z.string().optional(), arguments: z.string().optional() }),
})
const event = z.looseObject({
  type: z.string().optional(),
  delta: z.unknown().optional(),
  item: z
    .looseObject({
      type: z.string(),
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            tool_calls: z.array(call).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

/** Grade content, not merely an HTTP 200 or a keepalive; fragmented tool names are legal. */
export function gradeProviderStream(text: string, tools: boolean): boolean {
  let terminal = false
  let content = ""
  const calls = new Map<number, { name: string; arguments: string }>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const raw = line.slice(5).trim()
    if (raw === "[DONE]") {
      terminal = true
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = event.safeParse(value)
    if (!parsed.success) continue
    const data = parsed.data
    if (data.type === "response.failed" || data.type === "error") return false
    if (data.type === "response.completed") terminal = true
    if (data.type === "response.output_text.delta" && typeof data.delta === "string")
      content += data.delta
    if (data.type === "response.output_item.done" && data.item?.type === "function_call") {
      calls.set(calls.size, { name: data.item.name ?? "", arguments: data.item.arguments ?? "" })
    }
    for (const choice of data.choices ?? []) {
      content += choice.delta?.content ?? ""
      for (const delta of choice.delta?.tool_calls ?? []) {
        const previous = calls.get(delta.index) ?? { name: "", arguments: "" }
        calls.set(delta.index, {
          name: previous.name + (delta.function.name ?? ""),
          arguments: previous.arguments + (delta.function.arguments ?? ""),
        })
      }
    }
  }
  if (!terminal) return false
  if (!tools) return content.trim().length > 0
  return [...calls.values()].some((item) => {
    if (item.name !== "closure_probe") return false
    try {
      return z.object({ ok: z.literal(true) }).safeParse(JSON.parse(item.arguments)).success
    } catch {
      return false
    }
  })
}
