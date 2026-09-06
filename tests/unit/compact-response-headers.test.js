import { describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn() };

function comboOptions(handleSingleModel) {
  return {
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["provider/first", "provider/second"],
    handleSingleModel,
    log,
  };
}

function sseResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "x-upstream-request": "request-1" },
  });
}

describe("live combo response headers", () => {
  it("tracks a streamed response and preserves the replayed body", async () => {
    const response = await handleComboChat(comboOptions(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"served"}}]}\n\n',
      "data: [DONE]\n\n",
    ])));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served");
    expect(response.headers.get("x-upstream-request")).toBe("request-1");
    expect(response.headers.get("x-tokenproxy-combo")).toBe("true");
    expect(response.headers.get("x-tokenproxy-model")).toBe("provider/first");
  });

  it("tracks the model that returns a terminal client error", async () => {
    const handleSingleModel = vi.fn(async () => new Response("bad input", { status: 400 }));

    const response = await handleComboChat(comboOptions(handleSingleModel));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad input");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(response.headers.get("x-tokenproxy-combo")).toBe("true");
    expect(response.headers.get("x-tokenproxy-model")).toBe("provider/first");
  });

  it("marks an exhausted combo without claiming a failed value is a served model", async () => {
    const response = await handleComboChat(comboOptions(async () => {
      throw new Error("upstream unavailable");
    }));

    expect(response.status).toBe(502);
    expect(response.headers.get("x-tokenproxy-combo")).toBe("true");
    expect(response.headers.get("x-tokenproxy-model")).toBeNull();
  });
});
