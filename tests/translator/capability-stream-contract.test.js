import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { assertJson, assertStream } from "../contracts/run-capability-matrix.mjs";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";

const responseEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("capability stream contract", () => {
  it("rejects a semantic Responses event after response.completed", () => {
    const stream = [
      responseEvent("response.created", { type: "response.created" }),
      responseEvent("response.output_item.added", { type: "response.output_item.added" }),
      responseEvent("response.content_part.added", { type: "response.content_part.added" }),
      responseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "fixture-ok" }),
      responseEvent("response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } }),
      responseEvent("response.failed", { type: "response.failed" }),
      "data: [DONE]\n\n",
    ].join("");

    expect(() => assertStream("/v1/responses", stream, "late-response-event")).toThrow(/only \[DONE\]/);
  });

  it("requires the controlled chat completion usage totals", () => {
    expect(() => assertJson("/v1/chat/completions", {
      choices: [{ finish_reason: "stop", message: { content: "fixture-ok" } }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    })).toThrow(/Chat input usage/);
  });

  it("preserves the controlled Responses total through client usage filtering", () => {
    expect(filterUsageForFormat({
      input_tokens: 7,
      output_tokens: 2,
      total_tokens: 9,
    }, FORMATS.OPENAI_RESPONSES)).toEqual({
      input_tokens: 7,
      output_tokens: 2,
      total_tokens: 9,
    });
  });

  it("keeps trailing Responses reasoning at the OpenAI provider boundary", () => {
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "fixture-model", {
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Two plus two equals four." }],
      }],
    });
    expect(translated.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning_content: "Two plus two equals four.",
    }));
  });
});
