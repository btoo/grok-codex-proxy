import test from "node:test";
import assert from "node:assert/strict";
import { extractAccessToken, parseGrokVersion } from "../src/auth.js";

test("extractAccessToken chooses the latest OAuth record without exposing metadata", () => {
  assert.equal(
    extractAccessToken({
      older: { key: "old", expires_at: "2026-01-01T00:00:00Z" },
      newer: { key: "new", expires_at: "2026-02-01T00:00:00Z" }
    }),
    "new"
  );
});

test("parseGrokVersion reads the installed CLI version", () => {
  assert.equal(parseGrokVersion("grok 1.0.5 (abcdef)"), "1.0.5");
});
