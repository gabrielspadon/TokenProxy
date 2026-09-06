import { describe, expect, it, vi } from "vitest";
import { detectUpstreamErrorContent } from "open-sse/services/upstreamErrorContent.js";
import { peekStreamForContent } from "open-sse/utils/streamContent.js";

import { handleComboChat } from 'open-sse/services/combo.js';

const sse = (chunks) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );

const frame = (content) => ({
  id: "x", object: "chat.completion.chunk", created: 0, model: "m",
  choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
});

// qoder answers HTTP 200 and puts a non-200 upstream status INTO the assistant
// content as `[qoder error 429: …]`. Fallback did fire — the peek refuses to
// count that as content — but every member reported "provider returned an empty
// stream", so an exhausted combo answered 503 with no trace of the rate limit
// (#1996).
describe("a combo member's in-content upstream error keeps its reason (#1996)", () => {
  it("the peek reports the error instead of counting it as content", async () => {
    const peek = await peekStreamForContent(sse([frame("\n[qoder error 429: rate limited]")]));
    expect(peek.hasContent).toBe(false);
    expect(peek.upstreamError).not.toBeNull();
    expect(peek.upstreamError.status).toBe(429);
  });

  it("a real answer is untouched", async () => {
    const peek = await peekStreamForContent(sse([frame("Hello there")]));
    expect(peek.hasContent).toBe(true);
    expect(peek.upstreamError).toBeNull();
  });

  it("preserves an accepted stream error without replaying generation", async () => {
    const dispatch = vi.fn(async () => sse([frame('[qoder error 429: rate limited]')]));
    const response = await handleComboChat({ body: { messages: [{ role: 'user', content: 'hi' }] }, models: ['qoder/a', 'other/b'], handleSingleModel: dispatch, log: { info() {}, warn() {} }, comboStrategy: 'fallback' });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('rate limited');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("the status carried out is the upstream's, not a blanket 503", () => {
    expect(detectUpstreamErrorContent("[qoder error 429: rate limited]").status).toBe(429);
    // No status in the marker is the shape that must still fall back, just
    // without inventing one.
    expect(detectUpstreamErrorContent("[qoder error: boom]").status).toBeNull();
  });
});
