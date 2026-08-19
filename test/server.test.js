import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxyServer } from "../src/server.js";

async function withServer(testFn, options = {}) {
  let capturedRequest;
  const credentials = {
    async headers() {
      return { authorization: "Bearer upstream", "content-type": "application/json" };
    },
    async refresh() {}
  };
  const defaultFetchImpl = async (_url, init) => {
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
    fetchImpl: options.fetchImpl || defaultFetchImpl,
    upstreamUrl: "https://example.invalid/chat",
    logger: options.logger || { info() {}, error() {} },
    upstreamTimeoutMs: options.upstreamTimeoutMs
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
    assert.equal(body.models[0].display_name, "Grok 4.6 (subscription)");
    assert.equal(body.models[0].shell_type, "shell_command");
    assert.equal(body.models[0].supports_parallel_tool_calls, true);
    assert.equal(body.models[0].context_window, 256000);
    assert.deepEqual(
      body.models[0].supported_reasoning_levels.map(({ effort }) => effort),
      ["none", "low", "medium", "high", "xhigh"]
    );
  });
});

test("forwards Codex reasoning effort to Grok Chat Completions", async () => {
  await withServer(async ({ port, getCapturedRequest }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ input: "Think carefully", reasoning: { effort: "xhigh" } })
    });
    assert.equal(response.status, 200);
    assert.equal(getCapturedRequest().model, "grok-4.6");
    assert.equal(getCapturedRequest().reasoning_effort, "xhigh");
  });
});

test("forwards image input as structured multimodal content", async () => {
  await withServer(async ({ port, getCapturedRequest }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        input: [{
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_text", text: "Describe it" }
          ]
        }]
      })
    });
    assert.equal(response.status, 200);
    const content = getCapturedRequest().messages[0].content;
    assert.equal(content[0].type, "image_url");
    assert.equal(content[0].image_url.url, "data:image/png;base64,AAAA");
    assert.equal(content[1].text, "Describe it");
  });
});

test("aborts the upstream request when the Codex client disconnects", async () => {
  let notifyStarted;
  let notifyAborted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const aborted = new Promise((resolve) => { notifyAborted = resolve; });
  const fetchImpl = async (_url, init) => {
    notifyStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        notifyAborted();
        reject(init.signal.reason);
      }, { once: true });
    });
  };

  await withServer(async ({ port }) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/responses",
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" }
    });
    request.on("error", () => {});
    request.end(JSON.stringify({ input: "wait" }));
    await started;
    request.destroy();
    await aborted;
  }, { fetchImpl, logger: { info() {}, error() {} } });
});

test("logs request metadata without logging prompt content or credentials", async () => {
  const entries = [];
  const logger = {
    info(message) { entries.push(message); },
    error(message) { entries.push(message); }
  };
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ input: "super-secret-prompt" })
    });
    assert.equal(response.status, 200);
  }, { logger });

  assert.equal(entries.length, 1);
  assert.match(entries[0], /\"status\":200/);
  assert.match(entries[0], /\"requestBytes\":/);
  assert.match(entries[0], /\"upstreamModel\":\"grok-4\.6\"/);
  assert.match(entries[0], /\"reasoningEffort\":\"default\"/);
  assert.doesNotMatch(entries[0], /super-secret-prompt|test-token|Bearer upstream/);
});

test("returns and logs a distinct upstream timeout", async () => {
  const entries = [];
  const logger = {
    info(message) { entries.push(message); },
    error(message) { entries.push(message); }
  };
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });

  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ input: "wait" })
    });
    assert.equal(response.status, 504);
  }, { fetchImpl, logger, upstreamTimeoutMs: 10 });

  assert.equal(entries.length, 1);
  assert.match(entries[0], /\"outcome\":\"upstream_timeout\"/);
});
