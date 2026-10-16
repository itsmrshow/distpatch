import { z } from "zod"

export const providerListing = z.object({
  data: z.array(z.looseObject({ id: z.string(), status: z.unknown().optional() })),
})
export const providerAnswer = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.looseObject({ function: z.looseObject({ name: z.string() }) }))
            .optional(),
        }),
      }),
    )
    .optional(),
  output: z
    .array(
      z.looseObject({
        type: z.string(),
        name: z.string().optional(),
        content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
      }),
    )
    .optional(),
})
export const probeSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}
