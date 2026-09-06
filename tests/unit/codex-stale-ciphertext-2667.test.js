// #2667 — the Codex retry loop only ever looked at SSE-200 transients, and
// errorConfig's `{ status: 400, pass: true }` rule stops a 400 from rotating or
// locking, so a request carrying an encrypted reasoning blob the backend can no
// longer decrypt (minted by another account, or expired) hard-failed the turn.
// The blob is continuity-only, so dropping it and resending is a complete local
// recovery — no other account is needed.
import { afterEach, describe, expect, it, vi } from "vitest";

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const STALE_CIPHERTEXT_BODY = JSON.stringify({
  error: {
    message:
      "Invalid value for 'input[1].encrypted_content': the encrypted content could not be decrypted.",
    type: "invalid_request_error",
    code: "invalid_value",
  },
});

const UNRELATED_400_BODY = JSON.stringify({
  error: { message: "Unknown model 'gpt-9'.", type: "invalid_request_error" },
});

function jsonResponse(status, body) {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function emptySseResponse() {
  return new Response(
    new ReadableStream({ start: (controller) => controller.close() }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function bodyWithCiphertext() {
  return {
    input: [
      { role: "user", content: [{ type: "input_text", text: "run it" }] },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "planning" }],
        encrypted_content: "B".repeat(64),
      },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
  };
}

// Records the ciphertext present in args.body at each upstream attempt.
function stubUpstream(responses) {
  const seen = [];
  vi.spyOn(BaseExecutor.prototype, "execute").mockImplementation(function execute(args) {
    seen.push(
      (args.body?.input || [])
        .filter((item) => typeof item?.encrypted_content === "string")
        .length
    );
    return Promise.resolve({ response: responses[seen.length - 1], transformedBody: args.body });
  });
  return seen;
}

describe("Codex recovers from a stale encrypted-reasoning 400 (#2667)", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['x-tokenproxy-replay-safe','x-should-retry'])('does not repair or resend when %s denies replay',async header=>{
    const upstream=new Response(STALE_CIPHERTEXT_BODY,{status:400,headers:{[header]:'false'}});
    const seen=stubUpstream([upstream,emptySseResponse()]);
    const body=bodyWithCiphertext();
    const result=await new CodexExecutor().execute({model:'gpt-5.3-codex',body});
    expect(seen).toEqual([1]);expect(result.response).toBe(upstream);
    expect(body.input.some(item=>item.encrypted_content)).toBe(true);
    expect(await result.response.text()).toBe(STALE_CIPHERTEXT_BODY);
  });

  it('does not use an oversized diagnostic as proof of a repairable rejection',async()=>{
    const text=JSON.stringify({error:{message:'the encrypted content could not be decrypted '+ 'x'.repeat(20*1024)}});
    const upstream=jsonResponse(400,text);
    const seen=stubUpstream([upstream,emptySseResponse()]);
    const result=await new CodexExecutor().execute({model:'gpt-5.3-codex',body:bodyWithCiphertext()});
    expect(seen).toEqual([1]);expect(result.response).toBe(upstream);
    expect(await result.response.text()).toBe(text);
  });

  it('returns a stalled diagnostic after the inspection deadline without a second dispatch',async()=>{
    vi.useFakeTimers();
    const upstream=new Response(new ReadableStream(),{status:400});
    const seen=stubUpstream([upstream]);
    const pending=new CodexExecutor().execute({model:'gpt-5.3-codex',body:bodyWithCiphertext()});
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).response).toBe(upstream);expect(seen).toEqual([1]);
    await upstream.body.cancel();
  });

  it('cancels the discarded rejected body before the repaired dispatch',async()=>{
    const upstream=jsonResponse(400,STALE_CIPHERTEXT_BODY);
    let calls=0;
    vi.spyOn(BaseExecutor.prototype,'execute').mockImplementation(async args=>{
      calls++;
      if(calls===1)return {response:upstream,transformedBody:args.body};
      expect(upstream.bodyUsed).toBe(true);
      return {response:emptySseResponse(),transformedBody:args.body};
    });
    await new CodexExecutor().execute({model:'gpt-5.3-codex',body:bodyWithCiphertext()});
    expect(calls).toBe(2);
  });

  it('cancels both diagnostic branches and never resends when the caller aborts inspection',async()=>{
    const controller=new AbortController();
    let cancelled=false;
    const upstream=new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:400});
    const clone=upstream.clone.bind(upstream);
    vi.spyOn(upstream,'clone').mockImplementation(()=>{controller.abort();return clone();});
    const seen=stubUpstream([upstream]);
    const body=bodyWithCiphertext();
    await expect(new CodexExecutor().execute({model:'gpt-5.3-codex',body,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(seen).toEqual([1]);expect(body.input.some(item=>item.encrypted_content)).toBe(true);
    await vi.waitFor(()=>expect(cancelled).toBe(true));
  });

  it('does not reuse the original400 after the repaired attempt loses its transport outcome',async()=>{
    vi.spyOn(BaseExecutor.prototype,'execute')
      .mockResolvedValueOnce({response:jsonResponse(400,STALE_CIPHERTEXT_BODY)})
      .mockRejectedValueOnce(new Error('second attempt outcome unknown'));
    await expect(new CodexExecutor().execute({model:'gpt-5.3-codex',body:bodyWithCiphertext()})).rejects.toThrow('second attempt outcome unknown');
    expect(BaseExecutor.prototype.execute).toHaveBeenCalledTimes(2);
  });

  it("strips the ciphertext and retries once", async () => {
    const seen = stubUpstream([
      jsonResponse(400, STALE_CIPHERTEXT_BODY),
      emptySseResponse(),
    ]);
    const warn = vi.fn();

    const result = await new CodexExecutor().execute({
      model: "gpt-5.3-codex",
      body: bodyWithCiphertext(),
      log: { warn },
    });

    expect(seen).toEqual([1, 0]);
    expect(result.response.status).toBe(200);
  });

  it("also recognises a bare decrypt failure", async () => {
    const seen = stubUpstream([
      jsonResponse(400, JSON.stringify({ error: { message: "Failed to decrypt reasoning item." } })),
      emptySseResponse(),
    ]);

    const result = await new CodexExecutor().execute({
      model: "gpt-5.3-codex",
      body: bodyWithCiphertext(),
    });

    expect(seen).toEqual([1, 0]);
    expect(result.response.status).toBe(200);
  });

  it("retries once only — a second stale 400 is surfaced", async () => {
    const seen = stubUpstream([
      jsonResponse(400, STALE_CIPHERTEXT_BODY),
      jsonResponse(400, STALE_CIPHERTEXT_BODY),
    ]);

    const result = await new CodexExecutor().execute({
      model: "gpt-5.3-codex",
      body: bodyWithCiphertext(),
    });

    expect(seen).toEqual([1, 0]);
    expect(result.response.status).toBe(400);
  });

  it("leaves an unrelated 400 untouched and readable", async () => {
    const seen = stubUpstream([jsonResponse(400, UNRELATED_400_BODY)]);

    const result = await new CodexExecutor().execute({
      model: "gpt-5.3-codex",
      body: bodyWithCiphertext(),
    });

    expect(seen).toEqual([1]);
    expect(result.response.status).toBe(400);
    await expect(result.response.text()).resolves.toBe(UNRELATED_400_BODY);
  });

  it("does not retry when the request carries no ciphertext to drop", async () => {
    const seen = stubUpstream([jsonResponse(400, STALE_CIPHERTEXT_BODY)]);

    const result = await new CodexExecutor().execute({
      model: "gpt-5.3-codex",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    });

    expect(seen).toEqual([0]);
    expect(result.response.status).toBe(400);
  });
});
