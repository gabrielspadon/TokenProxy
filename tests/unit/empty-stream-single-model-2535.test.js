import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { peekStreamForContent } from "../../open-sse/utils/streamContent.js";

const chat = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");
const ping = readFileSync(
  new URL("../../src/app/api/models/test/ping.js", import.meta.url),
  "utf8",
);

const enc = new TextEncoder();
const sse = (frames) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const TEXT = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
const DONE = "data: [DONE]\n\n";

// #2535: the built-in model test passed while every external client hung. The
// two paths differ in exactly one thing that changes the outcome — the probe
// sends stream:false and the client sends stream:true — and only the
// non-streaming branch refused an upstream that answered 200 with nothing.
describe("an empty single-model stream is refused, not forwarded (#2535)", () => {
  it("the probe is the non-streaming path, which is why it stayed green", () => {
    expect(ping).toContain("stream: false");
  });

  it("a stream that carries only a role envelope reports no content", async () => {
    const peeked = await peekStreamForContent(sse([ROLE, DONE]));
    expect(peeked.hasContent).toBe(false);
  });

  it("a stream that carries text reports content and replays every byte", async () => {
    const peeked = await peekStreamForContent(sse([ROLE, TEXT, DONE]));
    expect(peeked.hasContent).toBe(true);
    const replayed = await new Response(peeked.body).text();
    expect(replayed).toBe(ROLE + TEXT + DONE);
  });

  it("a non-SSE reply is passed through untouched (body stays null)", async () => {
    const json = new Response('{"choices":[{"message":{"content":"hi"}}]}', {
      headers: { "content-type": "application/json" },
    });
    const peeked = await peekStreamForContent(json);
    expect(peeked).toEqual({ hasContent: true, body: null });
    expect(await json.text()).toContain("hi");
  });

  it("the single-model success path peeks before returning", () => {
    const branch = chat.slice(chat.indexOf("if (result.success) {"));
    const body = branch.slice(0, branch.indexOf("if (result.clientAborted"));
    expect(body).toContain("await peekStreamForContent(result.response)");
    expect(body).toContain("if (peeked.hasContent)");
  });

  it("accepted empty content returns a terminal error without dispatching another account", () => {
    const branch = chat.slice(chat.indexOf("if (result.success) {"));
    const body = branch.slice(0, branch.indexOf("if (result.clientAborted"));
    // Everything after the hasContent return is the empty-stream path.
    const empty = body.slice(body.indexOf("const reason ="));
    expect(empty).toContain("await markAccountUnavailable(");
    expect(empty).toContain("{ safeToReplay: false }");
    expect(empty).toContain("return terminalAttemptResponse(errorResponse(");
    expect(empty).not.toContain("excludeConnectionIds.add(credentials.connectionId)");
    expect(empty).not.toContain("continue;");
    expect(empty).not.toContain("return result.response");
  });

  it("an upstream error carried as content keeps its own reason and status", () => {
    const branch = chat.slice(chat.indexOf("if (result.success) {"));
    expect(branch).toContain("peeked.upstreamError?.reason");
    expect(branch).toContain("peeked.upstreamError?.status");
  });
});
