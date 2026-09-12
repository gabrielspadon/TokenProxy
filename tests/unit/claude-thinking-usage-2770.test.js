import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisibleTelemetryFixture } from "../fixtures/visible-telemetry.mjs";

// Public analytics and history deliberately exclude test-origin writes. The
// fixture verifies the origin of the rows each seeding call owns and
// re-identifies only those as a receipted synthetic import, so the public read
// under test stays the real one.
let visibleFixture;
async function withVisibleRows(produce) {
  visibleFixture ||= createVisibleTelemetryFixture(await (await import("@/lib/db/driver.js")).getAdapter(), "claude-thinking-usage-2770");
  return visibleFixture(produce);
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";
import { canonicalizeUsage, extractUsage } from "../../open-sse/utils/usageTracking.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

const CLAUDE_USAGE = {
  input_tokens: 22,
  output_tokens: 267,
  output_tokens_details: { thinking_tokens: 85 },
};

const CLAUDE_RESPONSE = {
  id: "msg_thinking_usage",
  model: "claude-sonnet-4-6",
  content: [],
  stop_reason: "end_turn",
  usage: CLAUDE_USAGE,
};

const OPENAI_USAGE = {
  prompt_tokens: 22,
  completion_tokens: 267,
  total_tokens: 289,
  completion_tokens_details: { reasoning_tokens: 85 },
};

async function transformClaudeStream(events) {
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`${events.join("\n\n")}\n\n`));
      controller.close();
    },
  });
  const output = input.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    "anthropic",
    null,
    null,
    "claude-sonnet-4-6",
    "claude-thinking-usage",
    { messages: [] },
  ));
  return new Response(output).text();
}

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-claude-thinking-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("#2770 Claude thinking-token usage", () => {
  it("limits Claude thinking to the nonnegative output-token subset", () => {
    const overOutput = toOpenAIUsage({
      input_tokens: 22,
      output_tokens: 267,
      output_tokens_details: { thinking_tokens: 999 },
    }, "claude");
    const zero = toOpenAIUsage({
      input_tokens: 22,
      output_tokens: 267,
      output_tokens_details: { thinking_tokens: 0 },
    }, "claude");
    const missing = toOpenAIUsage({ input_tokens: 22, output_tokens: 267 }, "claude");

    expect(overOutput).toMatchObject({
      completion_tokens: 267,
      completion_tokens_details: { reasoning_tokens: 267 },
    });
    expect(zero).not.toHaveProperty("completion_tokens_details");
    expect(missing).not.toHaveProperty("completion_tokens_details");
  });

  it("keeps Claude thinking as a nested reasoning subset on the OpenAI stream terminal", () => {
    const state = initState(FORMATS.OPENAI);
    claudeToOpenAIResponse({
      type: "message_start",
      message: { id: "msg_thinking_usage", model: "claude-sonnet-4-6", usage: { input_tokens: 22 } },
    }, state);

    const [terminal] = claudeToOpenAIResponse({
      type: "message_delta",
      usage: CLAUDE_USAGE,
      delta: { stop_reason: "end_turn" },
    }, state);

    expect(terminal.usage).toEqual(OPENAI_USAGE);
    expect(terminal.usage).not.toHaveProperty("reasoning_tokens");
    expect(JSON.stringify(terminal.usage)).not.toContain("thinking_tokens");

    expect(extractUsage({ type: "message_delta", usage: CLAUDE_USAGE })).toMatchObject({
      completion_tokens: 267,
      reasoning_tokens: 85,
    });
  });

  it("does not let the stream usage accumulator flatten Claude thinking on the client terminal", async () => {
    const output = await transformClaudeStream([
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_thinking_usage", model: "claude-sonnet-4-6", usage: { input_tokens: 22 } },
      })}`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        usage: CLAUDE_USAGE,
        delta: { stop_reason: "end_turn" },
      })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ]);
    const terminalLine = output.split("\n").find((line) =>
      line.startsWith("data: {") && line.includes('"finish_reason":"stop"'),
    );
    const terminal = JSON.parse(terminalLine.slice(6));

    expect(terminal.usage.completion_tokens).toBe(267);
    expect(terminal.usage.completion_tokens_details).toEqual({ reasoning_tokens: 85 });
    expect(terminal.usage).not.toHaveProperty("reasoning_tokens");
    expect(JSON.stringify(terminal.usage)).not.toContain("thinking_tokens");
  });

  it("keeps Claude thinking as a nested reasoning subset in a Chat non-stream response", () => {
    const translated = translateNonStreamingResponse(CLAUDE_RESPONSE, FORMATS.CLAUDE, FORMATS.OPENAI);

    expect(translated.usage).toEqual(OPENAI_USAGE);
    expect(translated.usage).not.toHaveProperty("reasoning_tokens");
    expect(JSON.stringify(translated.usage)).not.toContain("thinking_tokens");
  });

  it("keeps Claude thinking as a nested reasoning subset in a Responses non-stream response", () => {
    const translated = translateNonStreamingResponse(
      CLAUDE_RESPONSE,
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
    );

    expect(translated.usage).toEqual({
      input_tokens: 22,
      output_tokens: 267,
      total_tokens: 289,
      output_tokens_details: { reasoning_tokens: 85 },
    });
    expect(translated.usage).not.toHaveProperty("reasoning_tokens");
    expect(JSON.stringify(translated.usage)).not.toContain("thinking_tokens");
  });

  it("persists the numeric thinking subset internally without public Claude fields", async () => {
    const storedUsage = canonicalizeUsage(extractUsageFromResponse(CLAUDE_RESPONSE));
    expect(storedUsage).toMatchObject({
      prompt_tokens: 22,
      completion_tokens: 267,
      reasoning_tokens: 85,
    });
    expect(storedUsage).not.toHaveProperty("completion_tokens_details");

    await withVisibleRows(() => db.saveRequestUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      connectionId: "claude-thinking-usage",
      tokens: storedUsage,
      endpoint: "/v1/messages",
      status: "ok",
    }));

    const [entry] = await db.getUsageHistory({ provider: "anthropic" });
    expect(entry.tokens).toMatchObject({
      prompt_tokens: 22,
      completion_tokens: 267,
      reasoning_tokens: 85,
    });
    expect(JSON.stringify(entry.tokens)).not.toContain("thinking_tokens");
  });
});
