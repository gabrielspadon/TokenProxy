/**
 * #1584 — report: "the Codex provider only processes requests for its own
 * native models. It completely skips and ignores models from other providers
 * such as Anthropic, Gemini, Kimi, and GLM when they are in the queue."
 *
 * The premise does not hold in this tree. handleComboChat walks the member list
 * it is handed and never reads a provider off a member, so no provider can
 * shorten the queue. What the report describes is the `fallback` strategy doing
 * exactly its job: the first member that returns a usable answer wins, and a
 * ranked list whose top entry is healthy never reaches entry two. Round-robin
 * and fusion are the strategies that do visit the rest, selected per combo in
 * src/sse/handlers/chat.js.
 *
 * These run the real handleComboChat rather than reading the file, so they fail
 * if a provider filter is ever introduced anywhere along the walk.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleComboChat } from 'open-sse/services/combo.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const sse = (content) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: 'x',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'm',
              choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
            })}\n\n`
          )
        );
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );

const failure = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-tokenproxy-replay-safe': 'true' },
  });

// The report's own queue: a codex model ranked first, then the providers it is
// accused of ignoring.
const QUEUE = [
  'codex,gpt-5.1-codex',
  'claude,claude-sonnet-4-6',
  'gemini,gemini-3-pro',
  'kimi,kimi-k2.6',
];

const run = (handleSingleModel, models = QUEUE) =>
  handleComboChat({
    body: { messages: [{ role: 'user', content: 'hi' }] },
    models,
    handleSingleModel,
    log,
    comboName: 'ranked',
    comboStrategy: 'fallback',
    autoSwitch: false,
  });

describe('#1584 a combo is walked by position, not by provider', () => {
  it('reaches the non-codex members when the codex member fails', async () => {
    const tried = [];
    const res = await run(async (_body, modelStr) => {
      tried.push(modelStr);
      return modelStr.startsWith('codex')
        ? failure(503, 'codex overloaded')
        : sse('answer from claude');
    });

    expect(res.status).toBe(200);
    // A transient 503 is now retried on the same member before the combo
    // advances (#337), so the codex entry appears more than once. What #1584
    // guards is that the walk still REACHES the next provider by position.
    expect(tried.filter((m) => m !== 'codex,gpt-5.1-codex')).toEqual(['claude,claude-sonnet-4-6']);
    expect(tried.at(-1)).toBe('claude,claude-sonnet-4-6');
    expect(res.headers.get('x-tokenproxy-model')).toBe('claude,claude-sonnet-4-6');
  });

  it('keeps walking past several failing members of different providers', async () => {
    const tried = [];
    const res = await run(async (_body, modelStr) => {
      tried.push(modelStr);
      return modelStr.startsWith('kimi')
        ? sse('answer from kimi')
        : failure(429, `${modelStr} rate limited`);
    });

    expect(res.status).toBe(200);
    expect(tried).toEqual(QUEUE);
  });

  it('stops after accepted empty generation independently of provider identity', async () => {
    const tried = [];
    const empty = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );

    const res = await run(async (_body, modelStr) => {
      tried.push(modelStr);
      return modelStr.startsWith('codex') ? empty() : sse('answer from claude');
    });

    expect(res.status).toBe(502);
    expect(res.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(tried).toEqual(['codex,gpt-5.1-codex']);
  });

  it('stops at the first healthy member whatever its provider — that is fallback, not a codex rule', async () => {
    const triedCodexFirst = [];
    await run(async (_body, modelStr) => {
      triedCodexFirst.push(modelStr);
      return sse('first one answers');
    });
    expect(triedCodexFirst).toEqual(['codex,gpt-5.1-codex']);

    // Same list, codex demoted: now the claude member is the one that shortens
    // the queue, which is what proves the rule is positional.
    const triedClaudeFirst = [];
    await run(
      async (_body, modelStr) => {
        triedClaudeFirst.push(modelStr);
        return sse('first one answers');
      },
      ['claude,claude-sonnet-4-6', 'codex,gpt-5.1-codex']
    );
    expect(triedClaudeFirst).toEqual(['claude,claude-sonnet-4-6']);
  });
});
