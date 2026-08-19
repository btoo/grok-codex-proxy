#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const makeDefault = args.has("--make-default");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const launchLabel = "com.local.grok-codex-proxy";
const plistPath = path.join(launchAgentsDir, `${launchLabel}.plist`);
const logDir = path.join(codexHome, "log");

function commandPath(name) {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`Required command not found: ${name}`);
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function providerBlock() {
  return `
[model_providers.grok_subscription]
name = "Grok subscription (local)"
base_url = "http://127.0.0.1:62774/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.grok_subscription.auth]
command = "/usr/bin/printf"
args = ["local-grok-subscription"]
`;
}

function setTopLevel(source, key, value) {
  const firstTable = source.search(/^\s*\[/m);
  const splitAt = firstTable === -1 ? source.length : firstTable;
  let prefix = source.slice(0, splitAt);
  const suffix = source.slice(splitAt);
  const line = `${key} = ${value}`;
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  prefix = pattern.test(prefix) ? prefix.replace(pattern, line) : `${line}\n${prefix}`;
  return prefix + suffix;
}

function readTopLevel(source, key, fallback) {
  const firstTable = source.search(/^\s*\[/m);
  const prefix = source.slice(0, firstTable === -1 ? source.length : firstTable);
  const match = prefix.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match?.[1] || fallback;
}

if (process.platform !== "darwin") {
  throw new Error("The automatic service installer currently supports macOS only");
}

const grokBinary = commandPath("grok");
commandPath("codex");
if (!existsSync(authPath)) {
  throw new Error(`Grok login not found at ${authPath}; run \`grok login\` first`);
}

const profilePath = path.join(codexHome, "grok-subscription.config.toml");
const configPath = path.join(codexHome, "config.toml");
const profile = `model_provider = "grok_subscription"
model = "grok-build"
model_reasoning_effort = "none"
model_context_window = 256000
model_auto_compact_token_limit = 220000
${providerBlock()}`;

const servicePath = process.env.PATH || [path.dirname(grokBinary), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(projectRoot, "src", "server.js"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(os.homedir())}</string>
    <key>PATH</key><string>${xml(servicePath)}</string>
    <key>GROK_BINARY</key><string>${xml(grokBinary)}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, "grok-codex-proxy.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, "grok-codex-proxy.error.log"))}</string>
</dict>
</plist>
`;

if (dryRun) {
  console.log(JSON.stringify({ projectRoot, grokBinary, profilePath, plistPath, makeDefault }, null, 2));
  process.exit(0);
}

mkdirSync(codexHome, { recursive: true });
mkdirSync(logDir, { recursive: true });
mkdirSync(launchAgentsDir, { recursive: true });
writeFileSync(profilePath, profile, { mode: 0o600 });
writeFileSync(plistPath, plist, { mode: 0o644 });

if (makeDefault) {
  let config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (config && !existsSync(path.join(codexHome, "openai.config.toml"))) {
    const priorProfile = [
      `model_provider = ${readTopLevel(config, "model_provider", '"openai"')}`,
      `model = ${readTopLevel(config, "model", '"gpt-5.6-sol"')}`,
      `model_reasoning_effort = ${readTopLevel(config, "model_reasoning_effort", '"high"')}`,
      `model_context_window = ${readTopLevel(config, "model_context_window", "1000000")}`,
      `model_auto_compact_token_limit = ${readTopLevel(config, "model_auto_compact_token_limit", "950000")}`,
      ""
    ].join("\n");
    writeFileSync(path.join(codexHome, "openai.config.toml"), priorProfile, { mode: 0o600 });
  }
  if (existsSync(configPath)) {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    copyFileSync(configPath, `${configPath}.before-grok-proxy.${stamp}`);
  }
  config = setTopLevel(config, "model_provider", '"grok_subscription"');
  config = setTopLevel(config, "model", '"grok-build"');
  config = setTopLevel(config, "model_reasoning_effort", '"none"');
  config = setTopLevel(config, "model_context_window", "256000");
  config = setTopLevel(config, "model_auto_compact_token_limit", "220000");
  if (!config.includes("[model_providers.grok_subscription]")) config += providerBlock();
  writeFileSync(configPath, config, { mode: 0o600 });
}

const target = `gui/${process.getuid()}/${launchLabel}`;
spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
const bootstrap = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
if (bootstrap.status !== 0) process.exit(bootstrap.status || 1);
spawnSync("launchctl", ["kickstart", "-k", target], { stdio: "inherit" });

console.log(`Installed ${launchLabel}`);
console.log(`Profile: ${profilePath}`);
console.log(makeDefault ? "Grok is the default for new Codex tasks." : "Use --profile grok-subscription in Codex CLI.");
