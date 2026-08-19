import test from "node:test";
import assert from "node:assert/strict";
import { createProxyServer } from "../src/server.js";

async function withServer(testFn) {
  let capturedRequest;
  const credentials = {
    async headers() {
      return { authorization: "Bearer upstream", "content-type": "application/json" };
    },
    async refresh() {}
  };
  const fetchImpl = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "chat_1",
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }]
            },
            finish_reason: "tool_calls"
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const { server } = createProxyServer({
    host: "127.0.0.1",
    port: 0,
    localToken: "test-token",
    credentials,
    fetchImpl,
    upstreamUrl: "https://example.invalid/chat"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await testFn({ port, getCapturedRequest: () => capturedRequest });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves a streaming Responses function call", async () => {
  await withServer(async ({ port, getCapturedRequest }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-build",
        input: "Use echo",
        tools: [{ type: "function", name: "echo", parameters: { type: "object", properties: {} } }],
        stream: true
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /response\.function_call_arguments\.done/);
    assert.match(text, /response\.completed/);
    assert.equal(getCapturedRequest().tools[0].function.name, "echo");
  });
});

test("rejects the OpenAI bearer token when the local token is configured", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 401);
  });
});

test("serves the Codex model-catalog shape", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models?client_version=0.148.0`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.models[0].slug, "grok-build");
    assert.equal(body.models[0].shell_type, "shell_command");
    assert.equal(body.models[0].context_window, 256000);
  });
});
