// Context-tuning suite, task 6: prefix-stabilization telemetry + adaptive TTL.
//
// Pure-unit coverage of open-sse/utils/prefixStability.js (volatile-field
// detection accuracy, TTL choice boundaries, no-rewrite guarantee, rolling
// epochHitRate math) plus the anchorClaudeCache {ttl} seam, then integration
// through handleChatCore with a mocked executor: the context-status entry
// gains epochHitRate/volatileKeys, and the 1h tail anchor lands only when the
// flag is on AND the session's measured gaps outlive the 5m breakpoint.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EPOCH_RATE_WINDOW,
  chooseCacheTtl,
  recordEpochRate,
  topLevelKeySpans,
  volatileFieldReport,
} from '../../open-sse/utils/prefixStability.js';
import { anchorClaudeCache, countCacheAnchors } from '../../open-sse/translator/formats/claude.js';

const MIN = 60 * 1000;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('volatileFieldReport', () => {
  it('flags an early key that changed while the rest stayed stable', () => {
    const base = {
      metadata: { requestId: 'r1', mtime: 1 },
      system: 'S'.repeat(800),
      messages: [{ role: 'user', content: 'M'.repeat(800) }],
    };
    const next = {
      ...base,
      metadata: { requestId: 'r2-with-a-longer-id', mtime: 2 },
    };
    const report = volatileFieldReport([JSON.stringify(base), JSON.stringify(next)]);
    expect(report.pairs).toBe(1);
    expect(report.volatileKeys).toEqual(['metadata']);
    const system = report.keys.find((k) => k.key === 'system');
    expect(system.changes).toBe(0);
    expect(system.keptBytes).toBeGreaterThan(0);
    const metadata = report.keys.find((k) => k.key === 'metadata');
    expect(metadata.changes).toBe(1);
    expect(metadata.changedBytes).toBeGreaterThan(0);
  });

  it('does not flag a change whose value starts in the last 25% of the body', () => {
    const a = JSON.stringify({ head: 'h'.repeat(1000), tail: 'v1' });
    const b = JSON.stringify({ head: 'h'.repeat(1000), tail: 'v2-longer' });
    const report = volatileFieldReport([a, b]);
    expect(report.pairs).toBe(1);
    expect(report.keys.find((k) => k.key === 'tail').changes).toBe(1);
    expect(report.volatileKeys).toEqual([]);
  });

  it('flags nothing when every key changed — no single key is the divergence source', () => {
    const a = JSON.stringify({ a: '1', b: '2', c: '3' });
    const b = JSON.stringify({ a: 'x', b: 'y', c: 'z' });
    const report = volatileFieldReport([a, b]);
    expect(report.volatileKeys).toEqual([]);
    expect(report.keys.every((k) => k.changes === 1 && k.votes === 0)).toBe(true);
  });

  it('flags a key that only exists in the newer body', () => {
    const a = JSON.stringify({ system: 'S'.repeat(400), messages: 'M'.repeat(400) });
    const b = JSON.stringify({ metadata: { mtime: 1 }, system: 'S'.repeat(400), messages: 'M'.repeat(400) });
    const report = volatileFieldReport([a, b]);
    expect(report.volatileKeys).toEqual(['metadata']);
  });

  it('skips unparseable entries and counts only the pairs it compared', () => {
    const good1 = JSON.stringify({ a: '1' });
    const good2 = JSON.stringify({ a: '2' });
    const report = volatileFieldReport(['{not json', good1, good2, 42]);
    expect(report.pairs).toBe(1);
    expect(report.volatileKeys).toEqual(['a']);
  });

  it('accepts sketches and never mutates them (no-rewrite guarantee)', () => {
    const a = JSON.stringify({ metadata: { m: 1 }, system: 'S'.repeat(400) });
    const b = JSON.stringify({ metadata: { m: 2 }, system: 'S'.repeat(400) });
    const sketchA = deepFreeze(topLevelKeySpans(a));
    const sketchB = deepFreeze(topLevelKeySpans(b));
    const before = JSON.stringify([sketchA, sketchB]);
    // Frozen inputs throw on any mutation attempt in strict mode; a report
    // that comes back proves the inputs were only read.
    const report = volatileFieldReport([sketchA, sketchB]);
    expect(report.volatileKeys).toEqual(['metadata']);
    expect(JSON.stringify([sketchA, sketchB])).toBe(before);
    // The report is a fresh structure, detached from the sketches.
    report.volatileKeys.push('tampered');
    expect(report.keys.length).toBe(2);
  });
});

describe('chooseCacheTtl', () => {
  it('returns 5m with fewer than 3 samples, however large the gaps', () => {
    expect(chooseCacheTtl([])).toBe('5m');
    expect(chooseCacheTtl([30 * MIN])).toBe('5m');
    expect(chooseCacheTtl([30 * MIN, 30 * MIN])).toBe('5m');
  });

  it('returns 1h once 3 samples have a p90 gap over 20 minutes', () => {
    expect(chooseCacheTtl([25 * MIN, 25 * MIN, 25 * MIN])).toBe('1h');
    // one slow tail in a fast cadence still clears p90 at n=3 (max)
    expect(chooseCacheTtl([1 * MIN, 1 * MIN, 25 * MIN])).toBe('1h');
  });

  it('returns 5m when the p90 gap is at or under 20 minutes', () => {
    expect(chooseCacheTtl([10 * MIN, 10 * MIN, 10 * MIN])).toBe('5m');
    // boundary: the rule is strictly greater than 20 minutes
    expect(chooseCacheTtl([20 * MIN, 20 * MIN, 20 * MIN])).toBe('5m');
    // p90 semantics: one slow outlier among nine fast gaps stays 5m
    expect(chooseCacheTtl([...Array(9).fill(5 * MIN), 60 * MIN])).toBe('5m');
  });

  it('drops non-finite and negative samples before counting', () => {
    expect(chooseCacheTtl([NaN, -5, 25 * MIN, 25 * MIN, 25 * MIN])).toBe('1h');
    expect(chooseCacheTtl([NaN, 25 * MIN, 25 * MIN])).toBe('5m');
    expect(chooseCacheTtl(null)).toBe('5m');
  });
});

describe('recordEpochRate', () => {
  it('is undefined with no samples and ignores non-finite ones', () => {
    const rates = [];
    expect(recordEpochRate(rates, NaN)).toBeUndefined();
    expect(recordEpochRate(rates, 0.5)).toBe(0.5);
    expect(recordEpochRate(rates, NaN)).toBe(0.5);
  });

  it('keeps a rolling mean over the last EPOCH_RATE_WINDOW samples', () => {
    const rates = [];
    expect(recordEpochRate(rates, 0)).toBe(0);
    expect(recordEpochRate(rates, 1)).toBe(0.5);
    for (let i = 0; i < EPOCH_RATE_WINDOW + 5; i++) recordEpochRate(rates, 1);
    expect(rates.length).toBe(EPOCH_RATE_WINDOW);
    // the early 0 has rolled out of the window
    expect(recordEpochRate(rates, NaN)).toBe(1);
  });
});

describe('anchorClaudeCache {ttl} seam', () => {
  const mk = () => ({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'sys' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ],
  });

  it('defaults to the legacy policy: 1h on system, bare 5m on the tail', () => {
    const out = anchorClaudeCache(mk());
    expect(out.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(out.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('ttl "5m" is byte-identical to the default call', () => {
    const withDefault = JSON.stringify(anchorClaudeCache(mk()));
    const with5m = JSON.stringify(anchorClaudeCache(mk(), { ttl: '5m' }));
    expect(with5m).toBe(withDefault);
  });

  it('ttl "1h" upgrades only the conversation-tail anchor', () => {
    const out = anchorClaudeCache(mk(), { ttl: '1h' });
    expect(out.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // the system anchor already was 1h under the legacy policy
    expect(out.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(countCacheAnchors(out)).toBe(countCacheAnchors(anchorClaudeCache(mk())));
  });
});

// ---------------------------------------------------------------------------
// Integration through handleChatCore, executor mocked, no upstream contact.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatchedBodies: [],
}));

vi.mock('../../open-sse/utils/proxyFetch.js', async (orig) => ({
  ...(await orig()),
  proxyAwareFetch: vi.fn(async () => {
    throw new Error('no test in this file may reach an upstream');
  }),
  installGlobalProxyFetch: vi.fn(),
}));

vi.mock('../../open-sse/executors/index.js', () => ({
  getExecutor: () => ({ noAuth: true, execute: mocks.executeMock }),
}));

vi.mock('../../open-sse/utils/requestLogger.js', () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock('../../open-sse/utils/stream.js', () => ({
  COLORS: { red: '', reset: '' },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
const { readContextStatus, __setContextStatusDirForTest } =
  await import('../../open-sse/handlers/chatCore/contextStatusStore.js');

const PROVIDER = 'anthropic';
const MODEL = 'claude-opus-5';

function anthropicExecutorRes() {
  return {
    response: new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    url: 'https://api.anthropic.com/v1/messages',
    headers: {},
    transformedBody: null,
  };
}

// Claude-format body whose messages carry array content, so the anchoring
// pass can stamp the conversation-tail breakpoint the TTL assertions read.
function claudeBody(systemText) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    stream: false,
    max_tokens: 100,
    system: systemText,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `head ${'h'.repeat(1500)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: `reply ${'r'.repeat(1500)}` }] },
      { role: 'user', content: [{ type: 'text', text: 'follow-up question' }] },
    ],
  };
}

function baseArgs(overrides = {}) {
  return {
    body: claudeBody('stable system prompt'),
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: { apiKey: 'sk-test', providerSpecificData: {} },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      line: vi.fn(),
      tagForSession: () => 'TAG',
      nextTag: () => 'TAG',
      fmtThink: () => null,
    },
    connectionId: 'conn-prefix-1',
    clientRawRequest: { headers: {}, body: {} },
    ...overrides,
  };
}

async function drive(args) {
  const result = await handleChatCore(args);
  await result.response.text();
  return result;
}

// The conversation-tail anchor: the last cache_control stamped inside the
// messages array (system/tools anchors are a separate policy and sit earlier).
function tailAnchor(dispatched) {
  for (let i = dispatched.messages.length - 1; i >= 0; i--) {
    const content = dispatched.messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]?.cache_control) return content[j].cache_control;
    }
  }
  return null;
}

let storeDir;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchedBodies.length = 0;
  mocks.executeMock.mockImplementation(async (args) => {
    mocks.dispatchedBodies.push(args?.body);
    return anthropicExecutorRes();
  });
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-stability-test-'));
  __setContextStatusDirForTest(storeDir);
});

afterEach(() => {
  __setContextStatusDirForTest(null);
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('handleChatCore prefix telemetry', () => {
  it('lands epochHitRate and volatileKeys on the context-status entry', async () => {
    const sid = 'ad00e703';
    await drive(baseArgs({ sid, body: claudeBody('system prompt v1') }));
    let entry = await readContextStatus(sid);
    expect(entry).not.toBeNull();
    // First request of the session: nothing to compare against yet.
    expect(entry.epochHitRate).toBeUndefined();
    expect(entry.volatileKeys).toBeUndefined();

    // Second request changes only the early system key; messages stay stable.
    await drive(baseArgs({ sid, body: claudeBody('system prompt v2') }));
    entry = await readContextStatus(sid);
    expect(typeof entry.epochHitRate).toBe('number');
    expect(entry.epochHitRate).toBeGreaterThanOrEqual(0);
    expect(entry.epochHitRate).toBeLessThan(1);
    expect(entry.volatileKeys).toContain('system');
    expect(entry.volatileKeys).not.toContain('messages');
    expect(entry.volatileKeys.length).toBeLessThanOrEqual(3);

    // Identical resend: the epoch fully recovers, the rolling mean rises, and
    // the volatile list clears (nothing changed this pair).
    await drive(baseArgs({ sid, body: claudeBody('system prompt v2') }));
    const third = await readContextStatus(sid);
    expect(third.epochHitRate).toBeGreaterThan(entry.epochHitRate);
    expect(third.volatileKeys).toBeUndefined();
  });

  it('stamps the 1h tail anchor only once 3 measured gaps outlive 20 min, and only with the flag on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      const GAP = 25 * MIN;

      // Flag ON: gaps are recorded per request, so the 5th request is the
      // first to see 3 samples (its own gap is recorded after anchoring).
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(t0 + i * GAP);
        await drive(baseArgs({ sid: 'ad00e701', adaptiveCacheTtlEnabled: true }));
      }
      const onBodies = mocks.dispatchedBodies.slice(-5);
      for (const body of onBodies.slice(0, 4)) {
        expect(tailAnchor(body)).toEqual({ type: 'ephemeral' });
      }
      expect(tailAnchor(onBodies[4])).toEqual({ type: 'ephemeral', ttl: '1h' });

      // Flag OFF: identical cadence, the legacy 5m policy holds throughout.
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(t0 + i * GAP);
        await drive(baseArgs({ sid: 'ad00e702' }));
      }
      const offBodies = mocks.dispatchedBodies.slice(-5);
      for (const body of offBodies) {
        expect(tailAnchor(body)).toEqual({ type: 'ephemeral' });
      }

      // No-rewrite guarantee at the wire: while the rule says 5m, flag-on and
      // flag-off dispatch byte-identical bodies.
      expect(JSON.stringify(onBodies[0])).toBe(JSON.stringify(offBodies[0]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the 5m policy when the measured gaps are short, even with the flag on', async () => {
    const sid = 'ad00e704';
    for (let i = 0; i < 5; i++) {
      await drive(baseArgs({ sid, adaptiveCacheTtlEnabled: true }));
    }
    for (const body of mocks.dispatchedBodies.slice(-5)) {
      expect(tailAnchor(body)).toEqual({ type: 'ephemeral' });
    }
  });
});
