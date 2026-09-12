import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const loadJson = async (path) => JSON.parse(await readFile(`${root}/${path}`, "utf8"));
const bytesFrom = (fixture) => {
  if (fixture.encoding === "hex") {
    return fixture.frames.map((frame) => Buffer.from(frame, "hex"));
  }
  if (fixture.encoding === "aws-eventstream-prelude") {
    return [Buffer.from(fixture.preludeHex, "hex")];
  }
  return [Buffer.alloc(fixture.byteLength, fixture.fill)];
};

async function responseTextFrom(chunks, transform) {
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(input.pipeThrough(transform)).text();
}

describe("capability protocol fixtures", () => {
  it("executes valid, malformed and oversized Cursor protobuf fixtures", async () => {
    const valid = await loadJson("tests/fixtures/capabilities/protocols/protobuf-valid.json");
    const malformed = await loadJson("tests/fixtures/capabilities/protocols/protobuf-malformed.json");
    const oversized = await loadJson("tests/fixtures/capabilities/protocols/protobuf-oversized.json");
    const executor = new CursorExecutor();

    const success = executor.transformProtobufToJSON(
      Buffer.concat(bytesFrom(valid)),
      "fixture-model",
      { messages: [] },
    );
    expect(success.status).toBe(200);
    expect((await success.json()).choices[0].message.content).toBe("fixture-ok");

    for (const fixture of [malformed, oversized]) {
      const response = executor.transformProtobufToJSON(
        Buffer.concat(bytesFrom(fixture)),
        "fixture-model",
        { messages: [] },
      );
      expect(response.status).toBe(502);
      expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
    }
  });

  it("executes valid, malformed and oversized Kiro EventStream fixtures", async () => {
    const executor = new KiroExecutor();
    const valid = await loadJson("tests/fixtures/capabilities/protocols/eventstream-valid.json");
    const malformed = await loadJson("tests/fixtures/capabilities/protocols/eventstream-malformed.json");
    const oversized = await loadJson("tests/fixtures/capabilities/protocols/eventstream-oversized.json");

    const validate = async (fixture) => new TextDecoder().decode(
      await executor.validateAcceptedResponse(
        new Response(new Blob(bytesFrom(fixture)).stream()),
        { model: "fixture-model" },
        {
          maxBytes: 8 * 1024 * 1024,
          ttftTimeoutMs: 1000,
          stallTimeoutMs: 1000,
          signal: undefined,
        },
      ),
    );
    const success = await validate(valid);
    expect(success).toContain("fixture-ok");
    expect(success).toContain('"finish_reason":"stop"');

    const malformedText = await validate(malformed);
    expect(malformedText).toContain("kiro_missing_terminal");
    expect(malformedText).toContain('"safe_to_replay":false');
    const oversizedText = await validate(oversized);
    expect(oversizedText).toContain("kiro_missing_terminal");
    expect(oversizedText).toContain('"safe_to_replay":false');
  });

  it("executes valid, malformed and oversized Ollama NDJSON fixtures", async () => {
    const valid = await loadJson("tests/fixtures/capabilities/protocols/ndjson-valid.json");
    const malformed = await loadJson("tests/fixtures/capabilities/protocols/ndjson-malformed.json");
    const oversized = await loadJson("tests/fixtures/capabilities/protocols/ndjson-oversized.json");
    const transform = () => createSSETransformStreamWithLogger(
      FORMATS.OLLAMA,
      FORMATS.OPENAI,
      "ollama-local",
      null,
      null,
      "fixture-model",
    );

    const success = await responseTextFrom(valid.chunks.map((chunk) => Buffer.from(chunk)), transform());
    expect(success).toContain("fixture-ok");
    await expect(responseTextFrom(
      malformed.chunks.map((chunk) => Buffer.from(chunk)),
      transform(),
    )).rejects.toThrow("Invalid Ollama NDJSON record");
    await expect(responseTextFrom(bytesFrom(oversized), transform()))
      .rejects.toThrow("Ollama NDJSON record exceeded 1 MiB");
  });
});
