import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function defaultAuthPath() {
  return path.join(os.homedir(), ".grok", "auth.json");
}

export function extractAccessToken(authDocument) {
  if (!authDocument || typeof authDocument !== "object") {
    return null;
  }

  const candidates = Object.values(authDocument)
    .filter((value) => value && typeof value === "object" && typeof value.key === "string")
    .sort((left, right) => {
      const leftExpiry = Date.parse(left.expires_at ?? "") || 0;
      const rightExpiry = Date.parse(right.expires_at ?? "") || 0;
      return rightExpiry - leftExpiry;
    });

  return candidates[0]?.key || null;
}

export async function readAccessToken(authPath = defaultAuthPath()) {
  let document;
  try {
    document = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Grok OAuth state at ${authPath}: ${error.message}`);
  }

  const token = extractAccessToken(document);
  if (!token) {
    throw new Error(`No Grok OAuth access token found in ${authPath}; run \`grok login\``);
  }
  return token;
}

export function parseGrokVersion(output) {
  const match = String(output).match(/\b(\d+\.\d+\.\d+)\b/);
  if (!match) {
    throw new Error(`Unable to parse Grok CLI version from: ${String(output).trim()}`);
  }
  return match[1];
}

export async function readGrokVersion(grokBinary = process.env.GROK_BINARY || "grok") {
  const { stdout, stderr } = await execFileAsync(grokBinary, ["--version"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  return parseGrokVersion(stdout || stderr);
}

export async function refreshGrokLogin(grokBinary = process.env.GROK_BINARY || "grok") {
  await execFileAsync(grokBinary, ["models"], {
    timeout: 30_000,
    maxBuffer: 256 * 1024
  });
}

export class GrokCredentials {
  constructor(options = {}) {
    this.authPath = options.authPath || process.env.GROK_AUTH_PATH || defaultAuthPath();
    this.grokBinary = options.grokBinary || process.env.GROK_BINARY || "grok";
    this.version = options.version || null;
  }

  async headers(model) {
    if (!this.version) {
      this.version = await readGrokVersion(this.grokBinary);
    }
    const token = await readAccessToken(this.authPath);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": this.version,
      "x-grok-client-identifier": "grok-shell",
      "x-grok-model-override": model
    };
  }

  async refresh() {
    await refreshGrokLogin(this.grokBinary);
  }
}
