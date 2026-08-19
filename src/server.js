import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GrokCredentials } from "./auth.js";
import { buildChatRequest, chatResponseToResponse } from "./translate.js";
import { streamCompletedResponse } from "./sse.js";

const DEFAULT_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/chat/completions";

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function openAiError(res, status, message, type = "proxy_error", code = null) {
  json(res, status, { error: { message, type, code } });
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request body"), { status: 400 });
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function authorized(req, localToken) {
  if (!localToken) return true;
  const header = req.headers.authorization || "";
  return safeEqual(header, `Bearer ${localToken}`);
}

async function parseUpstreamResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Grok returned non-JSON data (${response.status})`);
  }
}

async function callGrok({ fetchImpl, credentials, upstreamUrl, upstreamModel, request }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = await credentials.headers(upstreamModel);
    const response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180_000)
    });
    const payload = await parseUpstreamResponse(response);
    if (response.ok) return payload;

    if (attempt === 0 && [401, 403].includes(response.status)) {
      await credentials.refresh();
      continue;
    }
    const message = payload?.error?.message || payload?.error || `Grok request failed (${response.status})`;
    throw Object.assign(new Error(String(message)), { status: response.status });
  }
  throw new Error("Grok authentication retry failed");
}

export function createProxyServer(options = {}) {
  const config = {
    host: options.host || process.env.HOST || "127.0.0.1",
    port: Number(options.port ?? process.env.PORT ?? 62774),
    localToken: options.localToken ?? process.env.GROK_CODEX_PROXY_KEY ?? "local-grok-subscription",
    publicModel: options.publicModel || process.env.PUBLIC_MODEL || "grok-build",
    upstreamModel: options.upstreamModel || process.env.GROK_MODEL || "grok-build",
    upstreamUrl: options.upstreamUrl || process.env.GROK_UPSTREAM_URL || DEFAULT_UPSTREAM,
    maxRequestBytes: Number(options.maxRequestBytes ?? process.env.MAX_REQUEST_BYTES ?? 8 * 1024 * 1024)
  };
  const fetchImpl = options.fetchImpl || fetch;
  const credentials = options.credentials || new GrokCredentials();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, model: config.publicModel });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, {
          models: [
            {
              slug: config.publicModel,
              display_name: "Grok Build (subscription)",
              description: "Grok Build through the local subscription proxy",
              default_reasoning_level: "none",
              supported_reasoning_levels: [
                { effort: "none", description: "Grok Build model default" }
              ],
              shell_type: "shell_command",
              visibility: "list",
              supported_in_api: true,
              priority: 1,
              additional_speed_tiers: [],
              service_tiers: [],
              default_service_tier: null,
              availability_nux: null,
              upgrade: null,
              include_skills_usage_instructions: false,
              include_plugin_usage_instructions: false,
              include_apps_usage_instructions: false,
              supports_reasoning_summary_parameter: false,
              default_reasoning_summary: "none",
              support_verbosity: false,
              default_verbosity: null,
              apply_patch_tool_type: null,
              web_search_tool_type: "text",
              truncation_policy: { mode: "tokens", limit: 220000 },
              supports_image_detail_original: false,
              context_window: 256000,
              max_context_window: 256000,
              auto_compact_token_limit: 220000,
              effective_context_window_percent: 90,
              experimental_supported_tools: [],
              input_modalities: ["text", "image"],
              supports_search_tool: false,
              use_responses_lite: false,
              node_repl_auto_review_required: false,
              node_repl_disabled: false,
              base_instructions:
                "You are Grok Build running as the model behind Codex. Follow the supplied user and developer instructions, use the provided tools precisely, and continue until the task is complete."
            }
          ]
        });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        return openAiError(res, 404, "Not found", "not_found");
      }
      if (!authorized(req, config.localToken)) {
        return openAiError(res, 401, "Invalid local proxy token", "authentication_error");
      }

      const body = await readJsonBody(req, config.maxRequestBytes);
      const request = buildChatRequest(body, config.upstreamModel);
      const chatResponse = await callGrok({
        fetchImpl,
        credentials,
        upstreamUrl: config.upstreamUrl,
        upstreamModel: config.upstreamModel,
        request
      });
      const response = chatResponseToResponse(body, chatResponse, {
        responseId: `resp_${randomUUID()}`,
        model: config.publicModel
      });

      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        return streamCompletedResponse(res, response);
      }
      return json(res, 200, response);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      openAiError(res, error.status || 502, error.message || "Proxy failure");
    }
  });

  return { server, config };
}

export async function startProxy(options = {}) {
  const { server, config } = createProxyServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  console.log(`grok-codex-proxy listening on http://${config.host}:${address.port}`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startProxy();
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
