import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GrokCredentials } from "./auth.js";
import { buildChatRequest, chatResponseToResponse } from "./translate.js";
import { streamCompletedResponse } from "./sse.js";

const DEFAULT_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/chat/completions";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000;

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
    return { body: text ? JSON.parse(text) : {}, bytes: total };
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

async function callGrok({
  fetchImpl,
  credentials,
  upstreamUrl,
  upstreamModel,
  request,
  signal,
  timeoutMs
}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = await credentials.headers(upstreamModel);
    const response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: fetchSignal
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

function requestMetrics(request, requestBytes) {
  const imageCount = request.messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) return total;
    return total + message.content.filter((part) => part?.type === "image_url").length;
  }, 0);
  return {
    requestBytes,
    upstreamBytes: Buffer.byteLength(JSON.stringify(request)),
    upstreamModel: request.model,
    reasoningEffort: request.reasoning_effort || "default",
    messageCount: request.messages.length,
    toolCount: request.tools?.length || 0,
    imageCount
  };
}

function writeRequestLog(logger, level, fields) {
  const method = typeof logger?.[level] === "function" ? level : "log";
  logger?.[method]?.(`[grok-codex-proxy] ${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "request",
    ...fields
  })}`);
}

export function createProxyServer(options = {}) {
  const config = {
    host: options.host || process.env.HOST || "127.0.0.1",
    port: Number(options.port ?? process.env.PORT ?? 62774),
    localToken: options.localToken ?? process.env.GROK_CODEX_PROXY_KEY ?? "local-grok-subscription",
    publicModel: options.publicModel || process.env.PUBLIC_MODEL || "grok-build",
    upstreamModel: options.upstreamModel || process.env.GROK_MODEL || "grok-4.6",
    upstreamUrl: options.upstreamUrl || process.env.GROK_UPSTREAM_URL || DEFAULT_UPSTREAM,
    maxRequestBytes: Number(options.maxRequestBytes ?? process.env.MAX_REQUEST_BYTES ?? 8 * 1024 * 1024),
    upstreamTimeoutMs: Number(
      options.upstreamTimeoutMs ?? process.env.GROK_UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS
    )
  };
  const fetchImpl = options.fetchImpl || fetch;
  const credentials = options.credentials || new GrokCredentials();
  const logger = options.logger || console;

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
              display_name: "Grok 4.6 (subscription)",
              description: "Grok 4.6 through the local subscription proxy",
              default_reasoning_level: "none",
              supported_reasoning_levels: [
                { effort: "none", description: "Use the Grok upstream default" },
                { effort: "low", description: "Faster responses with less reasoning" },
                { effort: "medium", description: "Balanced reasoning and latency" },
                { effort: "high", description: "More reasoning for difficult tasks" },
                { effort: "xhigh", description: "Maximum Grok reasoning effort" }
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
              include_plugin_usage_instructions: true,
              include_apps_usage_instructions: true,
              supports_reasoning_summary_parameter: false,
              default_reasoning_summary: "none",
              support_verbosity: false,
              default_verbosity: null,
              apply_patch_tool_type: null,
              web_search_tool_type: "text",
              truncation_policy: { mode: "tokens", limit: 400000 },
              supports_parallel_tool_calls: true,
              supports_image_detail_original: false,
              context_window: 500000,
              max_context_window: 500000,
              auto_compact_token_limit: 400000,
              effective_context_window_percent: 80,
              experimental_supported_tools: [],
              input_modalities: ["text", "image"],
              supports_search_tool: false,
              use_responses_lite: false,
              node_repl_auto_review_required: false,
              node_repl_disabled: false,
              tool_mode: "code_mode_only",
              base_instructions:
                "You are Grok 4.6 running as the model behind Codex. Follow the supplied user and developer instructions, use the provided tools precisely, and continue until the task is complete."
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

      const requestId = randomUUID();
      const startedAt = Date.now();
      const clientAbort = new AbortController();
      let status = 500;
      let outcome = "proxy_error";
      let metrics = {
        requestBytes: 0,
        upstreamBytes: 0,
        upstreamModel: config.upstreamModel,
        reasoningEffort: "unknown",
        messageCount: 0,
        toolCount: 0,
        imageCount: 0
      };
      let errorName;
      const abortForDisconnect = () => {
        if (!res.writableEnded) clientAbort.abort(new Error("Client disconnected"));
      };
      req.once("aborted", abortForDisconnect);
      res.once("close", abortForDisconnect);

      try {
        const parsed = await readJsonBody(req, config.maxRequestBytes);
        const body = parsed.body;
        const request = buildChatRequest(body, config.upstreamModel);
        metrics = requestMetrics(request, parsed.bytes);
        const chatResponse = await callGrok({
          fetchImpl,
          credentials,
          upstreamUrl: config.upstreamUrl,
          upstreamModel: config.upstreamModel,
          request,
          signal: clientAbort.signal,
          timeoutMs: config.upstreamTimeoutMs
        });
        const response = chatResponseToResponse(body, chatResponse, {
          responseId: `resp_${randomUUID()}`,
          model: config.publicModel
        });

        status = 200;
        outcome = "ok";
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
        errorName = error?.name || "Error";
        if (clientAbort.signal.aborted) {
          status = 499;
          outcome = "client_disconnected";
        } else if (error?.name === "TimeoutError") {
          status = 504;
          outcome = "upstream_timeout";
        } else {
          status = error.status || 502;
          outcome = status < 500 ? "invalid_request" : "upstream_error";
        }
        if (!res.destroyed && !res.writableEnded) {
          openAiError(res, status, error.message || "Proxy failure");
        }
      } finally {
        req.off("aborted", abortForDisconnect);
        res.off("close", abortForDisconnect);
        writeRequestLog(logger, status >= 500 ? "error" : "info", {
          requestId,
          status,
          outcome,
          durationMs: Date.now() - startedAt,
          ...metrics,
          ...(errorName ? { errorName } : {})
        });
      }
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
