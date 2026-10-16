import { expect, test } from "bun:test"
import { gradeProviderStream } from "../../../smoke/provider-stream"

test("live grader requires terminal content rather than keepalives or an error event", () => {
  expect(gradeProviderStream(": ping\n\ndata: [DONE]\n\n", false)).toBe(false)
  expect(gradeProviderStream('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', false)).toBe(
    false,
  )
  expect(
    gradeProviderStream(
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
      false,
    ),
  ).toBe(true)
  expect(gradeProviderStream('data: {"type":"response.failed"}\n\n', false)).toBe(false)
})

test("live grader reconstructs fragmented Chat tool names and JSON arguments", () => {
  const wire = [
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "closure_", arguments: '{"ok":' } }],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: "probe", arguments: "true}" } }] } },
      ],
    },
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .join("")
  expect(gradeProviderStream(`${wire}data: [DONE]\n\n`, true)).toBe(true)
  expect(gradeProviderStream(`${wire.replace("true}", "false}")}data: [DONE]\n\n`, true)).toBe(
    false,
  )
})

test("live grader recognizes Responses tool completion only with a terminal response", () => {
  const item =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"closure_probe","arguments":"{\\"ok\\":true}"}}\n\n'
  expect(gradeProviderStream(item, true)).toBe(false)
  expect(gradeProviderStream(`${item}data: {"type":"response.completed"}\n\n`, true)).toBe(true)
})
