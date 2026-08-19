import { randomUUID } from "node:crypto";

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (["input_text", "output_text", "text"].includes(part?.type)) return part.text || "";
      if (part?.type === "input_image") {
        const url = part.image_url || part.file_id || "attached image";
        return `[Image: ${url}]`;
      }
      if (part?.type === "input_file") {
        return `[File: ${part.filename || part.file_id || part.file_url || "attached file"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolOutputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textFromContent(output) || JSON.stringify(output);
  return JSON.stringify(output ?? null);
}

export function responsesInputToMessages(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input == null ? [] : Array.isArray(body.input) ? body.input : [body.input];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    if (item.type === "reasoning") continue;

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const argumentsText = item.arguments ??
        (item.input == null ? "{}" : JSON.stringify({ input: item.input }));
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id || `call_${randomUUID()}`,
            type: "function",
            function: {
              name: item.name,
              arguments: typeof argumentsText === "string" ? argumentsText : JSON.stringify(argumentsText)
            }
          }
        ]
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: toolOutputText(item.output)
      });
      continue;
    }

    if (item.type === "message" || item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      if (["system", "user", "assistant", "tool"].includes(role)) {
        messages.push({
          role,
          content: textFromContent(item.content),
          ...(item.tool_call_id ? { tool_call_id: item.tool_call_id } : {})
        });
      }
    }
  }

  if (!messages.length) {
    messages.push({ role: "user", content: "" });
  }
  return messages;
}

export function responsesToolsToChatTools(tools = []) {
  return tools
    .filter((tool) => tool?.type === "function" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
      }
    }));
}

export function responsesToolChoiceToChatChoice(choice) {
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice?.type === "function" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

export function buildChatRequest(body, upstreamModel) {
  const tools = responsesToolsToChatTools(body.tools);
  const request = {
    model: upstreamModel,
    messages: responsesInputToMessages(body),
    stream: false
  };

  if (tools.length) {
    request.tools = tools;
    request.tool_choice = responsesToolChoiceToChatChoice(body.tool_choice);
    request.parallel_tool_calls = body.parallel_tool_calls !== false;
  }
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  return request;
}

function usageFromChat(usage) {
  if (!usage) return null;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    total_tokens: usage.total_tokens ?? input + output
  };
}

function normalizeToolCalls(toolCalls = []) {
  return toolCalls.map((call) => ({
    id: `fc_${randomUUID()}`,
    type: "function_call",
    status: "completed",
    call_id: call.id || `call_${randomUUID()}`,
    name: call.function?.name || "unknown_tool",
    arguments: call.function?.arguments || "{}"
  }));
}

export function chatResponseToResponse(body, chatResponse, options = {}) {
  const responseId = options.responseId || `resp_${randomUUID()}`;
  const model = options.model || body.model || "grok-build";
  const message = chatResponse?.choices?.[0]?.message || {};
  const output = [];

  if (typeof message.content === "string" && message.content.length) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }]
    });
  }
  output.push(...normalizeToolCalls(message.tool_calls));

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens ?? null,
    model,
    output,
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: body.store ?? false,
    temperature: body.temperature ?? null,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: body.tools || [],
    top_p: body.top_p ?? null,
    truncation: body.truncation || "disabled",
    usage: usageFromChat(chatResponse?.usage),
    metadata: body.metadata || {}
  };
}
