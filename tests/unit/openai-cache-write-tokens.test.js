import { describe, it, expect } from "vitest";
import { canonicalizeUsage, extractUsage, resolveCacheTokens } from "../../open-sse/utils/usageTracking.js";
import { doneFields, extractUsageFromResponse, formatDoneLine } from "../../open-sse/handlers/chatCore/requestDetail.js";

// OpenAI reports its cache WRITE quantity at input_tokens_details.cache_write_tokens
// on GPT-5.6 and later — the only tier that charges for a cache write. Source:
// https://developers.openai.com/api/docs/guides/prompt-caching ("Track
// usage.input_tokens_details.cached_tokens, usage.input_tokens_details.cache_write_tokens,
// input-token counts, latency, and realized cost", and the three cost functions
// computing ordinary_input_tokens = input_tokens - cached_tokens - cache_write_tokens).
//
// CACHE_WRITE_NESTED listed only the `cache_creation_tokens` spelling, so the
// nested form OpenAI documents fell through to 0. Raw upstream bodies are not
// retained, so this states what the parser drops, not what any past request
// reported. OpenAI accounting is INCLUSIVE, so recognizing the write must not
// change prompt_tokens.
describe("OpenAI nested cache_write_tokens", () => {
  const DOCUMENTED_USAGE = {
    input_tokens: 20000,
    output_tokens: 500,
    input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 6000 },
    output_tokens_details: { reasoning_tokens: 200 },
  };
  it('keeps nested cache writes in structured and human completion logs', () => {
    const usage = extractUsageFromResponse({ usage: DOCUMENTED_USAGE });
    expect(doneFields({ usage, latency: { total: 100 } })).toMatchObject({ in: 20000, cr: 12000, cw: 6000, ctx: 20000 });
    expect(formatDoneLine({ usage, latency: { total: 100 } })).toContain('+6000');
  });

  it("resolves the nested write count without flipping to exclusive accounting", () => {
    expect(resolveCacheTokens(DOCUMENTED_USAGE)).toEqual({
      read: 12000,
      write: 6000,
      inclusive: true,
    });
  });

  it("canonicalizes a streaming response.completed frame with the write intact", () => {
    const usage = extractUsage({ type: "response.completed", response: { usage: DOCUMENTED_USAGE } });
    expect(canonicalizeUsage(usage)).toMatchObject({
      prompt_tokens: 20000,
      cached_tokens: 12000,
      cache_creation_input_tokens: 6000,
      reasoning_tokens: 200,
    });
  });

  it("canonicalizes a non-streaming Responses body with the write intact", () => {
    const usage = extractUsageFromResponse({ usage: DOCUMENTED_USAGE });
    expect(canonicalizeUsage(usage)).toMatchObject({
      prompt_tokens: 20000,
      cached_tokens: 12000,
      cache_creation_input_tokens: 6000,
    });
  });

  it("keeps the OpenAI chat-completions spelling working too", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 8000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 2000 },
      },
    });
    expect(canonicalizeUsage(usage)).toMatchObject({
      prompt_tokens: 8000,
      cached_tokens: 5000,
      cache_creation_input_tokens: 2000,
    });
  });

  it("leaves Anthropic's exclusive fold unchanged", () => {
    expect(canonicalizeUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 248,
    })).toMatchObject({
      prompt_tokens: 2148,
      cached_tokens: 1800,
      cache_creation_input_tokens: 248,
    });
  });

  it("does not inflate input when the write is reported with no read", () => {
    // A cache-miss turn reports a write and no cached_tokens. The nested
    // spelling is OpenAI's, so accounting is INCLUSIVE: input_tokens already
    // counts those 6000 tokens. Folding them in (Anthropic's convention) would
    // bill 26000 against a 20000-token request.
    const usage = { input_tokens: 20000, output_tokens: 500, input_tokens_details: { cache_write_tokens: 6000 } };
    expect(resolveCacheTokens(usage)).toEqual({ read: undefined, write: 6000, inclusive: true });
    expect(canonicalizeUsage(usage)).toMatchObject({
      prompt_tokens: 20000,
      total_tokens: 20500,
      cache_creation_input_tokens: 6000,
    });
  });

  it("still folds an Anthropic first write, where accounting is exclusive", () => {
    // Same shape (write present, read absent) but Anthropic's spelling, so the
    // fold MUST happen: input_tokens excludes the cache there.
    expect(canonicalizeUsage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 248 }))
      .toMatchObject({ prompt_tokens: 348, cached_tokens: 0, cache_creation_input_tokens: 248 });
  });

  it("separates a reported zero write from an unreported one at the presence flag", () => {
    // requestStats.cacheCreationTokens is 0 in both cases; cacheWritePresent is
    // what distinguishes them, and contextRepo derives it from the same aliases
    // the resolver reads. An absent field must stay absent so the dashboard can
    // render Unknown rather than a confident zero.
    const reportedZero = { input_tokens: 5000, input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 0 } };
    const unreported = { input_tokens: 5000, input_tokens_details: { cached_tokens: 3000 } };
    expect(resolveCacheTokens(reportedZero).write).toBe(0);
    expect(resolveCacheTokens(unreported).write).toBeUndefined();
    // Both canonicalize to a 0 count; only the presence signal tells them apart.
    expect(canonicalizeUsage(reportedZero).cache_creation_input_tokens).toBe(0);
    expect(canonicalizeUsage(unreported).cache_creation_input_tokens).toBe(0);
  });

  it("keeps the Responses reasoning field through non-streaming extraction", () => {
    // The Claude branch matches on input_tokens, which a Responses body also
    // sets, and it read only the `thinking_tokens` spelling.
    expect(extractUsageFromResponse({ usage: {
      input_tokens: 9000, output_tokens: 800,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens_details: { reasoning_tokens: 300 },
    } })).toMatchObject({ reasoning_tokens: 300 });
  });

  it("adds no flat cache alias to a plain Claude body", () => {
    // canonicalizeUsage logs ACCT.alias-dropped on an OWN `cache_write_tokens`
    // key, and `{ k: undefined }` creates one. Lifting the nested key out here
    // would fire that log on every non-streaming Claude request.
    const usage = extractUsageFromResponse({ usage: { input_tokens: 100, output_tokens: 10 } });
    expect(Object.prototype.hasOwnProperty.call(usage, "cache_write_tokens")).toBe(false);
  });

  it("reports a genuine absence as absent, never as a zero write", () => {
    // Pre-GPT-5.6 models report no write field at all. `write` must stay
    // undefined so a reader can tell "not reported" from "reported none".
    expect(resolveCacheTokens({ input_tokens: 5000, input_tokens_details: { cached_tokens: 3000 } }))
      .toEqual({ read: 3000, write: undefined, inclusive: true });
  });
});
