import { describe, expect, it, beforeAll, afterAll } from "vitest";

// Exercise explicit request-log consent and header masking through real file writes. The point of this suite is a regression gate: masking was once
// disabled in place ("keep full token for testing") and shipped that way, which
// wrote provider OAuth tokens to disk verbatim whenever request logging was on.
let fs, os, path, logsDir, cwdBefore;

beforeAll(async () => {
  fs = await import("fs");
  os = await import("os");
  path = await import("path");
  // Each session resolves its owned retention ring under the current directory.
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-logtest-"));
  cwdBefore = process.cwd();
  process.chdir(logsDir);
  process.env.ENABLE_REQUEST_LOGS = "true";
});

afterAll(() => {
  if (cwdBefore) process.chdir(cwdBefore);
  if (logsDir) fs.rmSync(logsDir, { recursive: true, force: true });
});

function readSessionFile(name) {
  const root = path.join(logsDir, "logs", "requests-v2");
  const sessions = fs.readdirSync(root);
  for (const s of sessions) {
    const f = path.join(root, s, name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  return null;
}

describe("request log header masking", () => {
  it("never writes a bearer token verbatim", async () => {
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "claude-opus-5");

    const secret = "tok_ThisIsARealisticLookingFakeToken9999";
    logger.logClientRawRequest("/v1/chat/completions", { model: "x" }, {
      authorization: `Bearer ${secret}`,
      "x-api-key": "sk-client-key-abcdef123456",
      "content-type": "application/json",
      "x-debug-message": "Bearer abcdefghijklmnop",
    });

    await logger.flush();
    const written = readSessionFile("1_req_client.json");
    expect(written).toBeTruthy();

    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("sk-client-key-abcdef123456");

    // Scheme and a 4-char tail survive so logs stay useful for telling
    // credentials apart, and non-sensitive headers are untouched.
    expect(written.headers.authorization).toBe("Bearer ***9999");
    expect(written.headers["x-api-key"]).toBe("***3456");
    expect(written.headers["content-type"]).toBe("application/json");
  });

  it("masks short credential values too", async () => {
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "short-secret");

    logger.logTargetRequest("https://api.githubcopilot.com/v1/messages", {
      authorization: "Bearer abc",
      cookie: "session=deadbeef",
    }, { model: "claude-opus-5" });

    await logger.flush();
    const written = readSessionFile("4_req_target.json");
    expect(written).toBeTruthy();
    expect(JSON.stringify(written)).not.toContain("deadbeef");
    expect(written.headers.authorization).toBe("Bearer ***");
  });
});
