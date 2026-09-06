import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleComboChat, resetComboRotation } from '../../open-sse/services/combo.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// JSON, not SSE: peekStreamForContent short-circuits on a non-event-stream body,
// so the only timer the combo runs under is its own retry wait.
function okResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-tokenproxy-replay-safe': 'true', ...headers },
  });
}

async function runCombo(responders, models = ['p1/first', 'p2/second']) {
  const attempted = [];
  const pending = handleComboChat({
    body: { model: 'combo', messages: [{ role: 'user', content: 'hi' }] },
    models,
    handleSingleModel: async (_body, modelStr) => {
      attempted.push(modelStr);
      return responders[modelStr]();
    },
    log: silentLog,
    comboName: 'combo',
    comboStrategy: 'fallback',
  });
  // Drive every retry wait the combo schedules, including ones armed mid-advance.
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  const response = await pending;
  return { attempted, response, text: await response.text() };
}

describe('combo retries a transient member before advancing (#337)', () => {
  beforeEach(() => {
    resetComboRotation();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('retries the same member after a short transient cooldown', async () => {
    let calls = 0;
    const { attempted, text } = await runCombo({
      'p1/first': () =>
        ++calls === 1 ? errorResponse(503, 'No capacity') : okResponse('from first'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p1/first']);
    expect(text).toContain('from first');
  });

  it('falls through to the next member once the retry budget is spent', async () => {
    const { attempted, text } = await runCombo({
      'p1/first': () => errorResponse(503, 'No capacity'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p1/first', 'p1/first', 'p2/second']);
    expect(text).toContain('from second');
  });

  it('advances immediately when the provider asks for a wait longer than the cap', async () => {
    const { attempted, text } = await runCombo({
      'p1/first': () => errorResponse(503, 'No capacity', { 'Retry-After': '120' }),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p2/second']);
    expect(text).toContain('from second');
  });

  it("waits exactly as long as the provider's own Retry-After", async () => {
    let calls = 0;
    const { attempted } = await runCombo({
      'p1/first': () =>
        ++calls === 1
          ? errorResponse(503, 'Service unavailable', { 'Retry-After': '8' })
          : okResponse('from first'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p1/first']);
  });

  it('advances immediately when the provider states no delay at all', async () => {
    const { attempted, text } = await runCombo({
      'p1/first': () => errorResponse(502, 'upstream failed'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p2/second']);
    expect(text).toContain('from second');
  });

  it('never retries a client error that stops the combo outright', async () => {
    const { attempted, response } = await runCombo({
      'p1/first': () => errorResponse(400, 'Bad request'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first']);
    expect(response.status).toBe(400);
  });

  it('does not retry a rate limit, which belongs to the account not the member', async () => {
    const { attempted, text } = await runCombo({
      'p1/first': () => errorResponse(429, 'Rate limit exceeded'),
      'p2/second': () => okResponse('from second'),
    });

    expect(attempted).toEqual(['p1/first', 'p2/second']);
    expect(text).toContain('from second');
  });
});
