import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatRequest,
  chatResponseToResponse,
  responsesInputToMessages
} from "../src/translate.js";

test("translates Codex function definitions to Chat Completions tools", () => {
  const request = buildChatRequest(
    {
      instructions: "Be precise.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Use the tool" }] }],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          strict: false,
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        },
        { type: "web_search" }
      ],
      tool_choice: "auto",
      reasoning: { effort: "high" }
    },
    "grok-build"
  );

  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[1].content, "Use the tool");
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].function.name, "read_file");
  assert.equal(request.reasoning_effort, "high");
});

test("wraps Responses custom tools as Chat Completions functions", () => {
  const request = buildChatRequest(
    {
      input: "Use Code Mode",
      tools: [{
        type: "custom",
        name: "exec",
        description: "Execute JavaScript through Codex Code Mode.",
        format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" }
      }],
      tool_choice: { type: "custom", name: "exec" }
    },
    "grok-4.6"
  );

  assert.equal(request.tools[0].type, "function");
  assert.equal(request.tools[0].function.name, "exec");
  assert.equal(request.tools[0].function.parameters.properties.input.type, "string");
  assert.deepEqual(request.tool_choice, { type: "function", function: { name: "exec" } });
});

test("uses the upstream default for none reasoning effort", () => {
  const request = buildChatRequest(
    { input: "Be quick", reasoning: { effort: "none" } },
    "grok-build"
  );
  assert.equal(request.reasoning_effort, undefined);
});

test("rejects unsupported Grok reasoning effort values", () => {
  assert.throws(
    () => buildChatRequest(
      { input: "Think", reasoning: { effort: "max" } },
      "grok-build"
    ),
    /Unsupported Grok reasoning effort: max/
  );
});

test("translates Responses function-call history back to Chat messages", () => {
  const messages = responsesInputToMessages({
    input: [
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "contents" }
    ]
  });
  assert.equal(messages[0].tool_calls[0].function.name, "read_file");
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call_1", content: "contents" });
});

test("translates Responses custom-tool history back to Chat messages", () => {
  const messages = responsesInputToMessages({
    input: [
      { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "text(42);" },
      { type: "custom_tool_call_output", call_id: "call_exec", output: "42" }
    ]
  });
  assert.equal(messages[0].tool_calls[0].function.name, "exec");
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"input":"text(42);"}');
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call_exec", content: "42" });
});

test("preserves Responses image inputs as Chat Completions image_url blocks", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const messages = responsesInputToMessages({
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is shown?" },
          { type: "input_image", image_url: dataUrl, detail: "high" }
        ]
      }
    ]
  });

  assert.deepEqual(messages[0].content, [
    { type: "text", text: "What is shown?" },
    { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
  ]);
  const textParts = messages[0].content.filter((part) => part.type === "text");
  assert.equal(textParts.some((part) => part.text.includes("base64")), false);
});

test("rejects image file IDs instead of flattening them into prompt text", () => {
  assert.throws(
    () => responsesInputToMessages({
      input: [{ role: "user", content: [{ type: "input_image", file_id: "file_secret" }] }]
    }),
    /Image file IDs are not supported/
  );
});

test("translates Grok tool calls to Responses function calls", () => {
  const response = chatResponseToResponse(
    { model: "grok-build", tools: [] },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    }
  );
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].call_id, "call_1");
});

test("translates wrapped Grok exec calls to Responses custom tool calls", () => {
  const response = chatResponseToResponse(
    { model: "grok-build", tools: [{ type: "custom", name: "exec" }] },
    {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_exec",
            type: "function",
            function: { name: "exec", arguments: '{"input":"text(42);"}' }
          }]
        },
        finish_reason: "tool_calls"
      }]
    }
  );
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].call_id, "call_exec");
  assert.equal(response.output[0].name, "exec");
  assert.equal(response.output[0].input, "text(42);");
});
