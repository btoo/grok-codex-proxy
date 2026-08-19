# Grok subscription provider for Codex

This local-only adapter lets Codex speak the OpenAI Responses protocol while
using the subscription-backed Grok CLI chat proxy. It does not use an xAI API
key or xAI API credits.

Requirements: macOS, Node.js 20 or newer, Codex CLI, Grok CLI, and an active
Grok login with subscription access to Grok Build.

## Security model

- The server binds to `127.0.0.1` by default.
- It reads the current OAuth token from `~/.grok/auth.json` only when calling
  Grok and never returns or logs the token.
- Codex authenticates with a separate local bearer value so its OpenAI account
  token is not sent to the proxy.
- On an upstream 401/403, the proxy runs `grok models` once to refresh the
  existing Grok login and retries.

## Run

```bash
git clone git@github.com:btoo/grok-codex-proxy.git
cd grok-codex-proxy
npm test
npm start
```

Defaults:

- Address: `http://127.0.0.1:62774/v1`
- Local bearer token: `local-grok-subscription`
- Public/upstream model: `grok-build`

Environment overrides include `HOST`, `PORT`, `GROK_CODEX_PROXY_KEY`,
`PUBLIC_MODEL`, `GROK_MODEL`, `GROK_BINARY`, `GROK_AUTH_PATH`, and
`GROK_UPSTREAM_URL`.

## Codex provider configuration

For automatic macOS installation, first install and sign in to both CLIs, then
run:

```bash
grok login
npm run install:macos
```

The installer creates a LaunchAgent, preserves the previous OpenAI defaults in
`~/.codex/openai.config.toml`, and makes Grok the default for new Codex tasks.
It also creates a timestamped backup of `~/.codex/config.toml`.

Use `node scripts/install-macos.mjs --dry-run` to inspect the resolved paths
without changing anything. Without `--make-default`, the script installs only
the service and `grok-subscription` CLI profile.

The installation adds a user-level custom provider equivalent to:

```toml
[model_providers.grok_subscription]
name = "Grok subscription (local)"
base_url = "http://127.0.0.1:62774/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.grok_subscription.auth]
command = "/usr/bin/printf"
args = ["local-grok-subscription"]
```

Select it for one CLI run with `--profile grok-subscription` after the profile
is installed, or choose the Grok model from Codex Desktop if it appears in the
model picker.

When installed with `--make-default`, the provider becomes the default for new
Codex tasks and the prior OpenAI defaults remain available through
`~/.codex/openai.config.toml`.

CLI selection examples:

```bash
# Current default: Grok subscription
codex exec "your task"

# One OpenAI-backed CLI run
codex exec --profile openai "your task"

# Explicit Grok profile
codex exec --profile grok-subscription "your task"
```

The Desktop app reads the default selection from `~/.codex/config.toml` for
new tasks. Restart the app if the model picker or a newly created task still
shows the prior provider.

## Background service

The portable installer uses the macOS LaunchAgent
`com.local.grok-codex-proxy` and starts automatically at login.

```bash
# Health
curl http://127.0.0.1:62774/healthz

# Restart
launchctl kickstart -k "gui/$(id -u)/com.local.grok-codex-proxy"

# Logs
tail -f ~/.codex/log/grok-codex-proxy.log
tail -f ~/.codex/log/grok-codex-proxy.error.log
```

If Grok authentication expires, run `grok login`; the next proxy request reads
the refreshed token automatically.

## Current scope

- Responses text output
- Function tool calls and function-call outputs
- Responses SSE event framing (buffered upstream; emitted after Grok completes)
- Grok OAuth refresh retry

The adapter intentionally ignores provider-native `web_search` tools because
Codex cannot execute those as local function calls. All ordinary Codex function
tools are forwarded.
