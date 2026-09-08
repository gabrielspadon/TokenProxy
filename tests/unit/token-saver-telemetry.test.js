import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Token-saver REQ telemetry: per-stage byte deltas in save=, the ~4
// chars/token estimate in save_tok=, the cache-epoch prefix in ce=, the
// XFORM saver path codes on the REQ line, and the saver-guard
// phantom-growth line. Every byte number is recomputed here from
// mock-observed serializations, never trusted from the implementation
// under test.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  headroom: {
    compressWithHeadroom: vi.fn(async () => null),
    // like the real module: a line when stats exist, null otherwise, so a
    // successful run never also notes XFORM.headroom-skip
    formatHeadroomLog: vi.fn((stats) => (stats ? 'headroom: applied' : null)),
    formatHeadroomSizeLog: vi.fn(() => ''),
    isHeadroomPhantomSavings: vi.fn(() => false),
  },
  // stage snapshots observed independently inside the mocked boundaries
  rtkObserved: { before: null, after: null },
  headroomObserved: { before: null, after: null },
  privacyObserved: { before: null, after: null },
  dispatched: null,
}));

vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
vi.mock('../../open-sse/executors/index.js', () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: (...args) => {
      // capture the body the pipeline dispatched (post-saver, pre-wire)
      mocks.dispatched = JSON.stringify(args[0]?.body);
      return mocks.executeMock(...args);
    },
  }),
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

// RTK stands in for the real compressor: shrinks ONE tool message in place
// by an exact, known amount and reports one hit. Targets tool_call_id "c1".
vi.mock('../../open-sse/rtk/index.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
      if (!enabled || !body?.messages) return null;
      mocks.rtkObserved.before = JSON.stringify(body);
      const target = body.messages.find(
        (m) => m?.role === 'tool' && m?.tool_call_id === 'c1' && typeof m.content === 'string'
      );
      const shrunk = target && target.content.length === 900;
      if (shrunk) target.content = 'x'.repeat(100);
      mocks.rtkObserved.after = JSON.stringify(body);
      return {
        bytesBefore: mocks.rtkObserved.before.length,
        bytesAfter: mocks.rtkObserved.after.length,
        hits: shrunk ? [{ filter: 'fat' }] : [],
      };
    }),
  };
});

vi.mock('../../open-sse/rtk/headroom.js', () => ({
  compressWithHeadroom: mocks.headroom.compressWithHeadroom,
  formatHeadroomLog: mocks.headroom.formatHeadroomLog,
  formatHeadroomSizeLog: mocks.headroom.formatHeadroomSizeLog,
  isHeadroomPhantomSavings: mocks.headroom.isHeadroomPhantomSavings,
}));

vi.mock('../../open-sse/rtk/pxpipe.js', () => ({
  compressWithPxpipe: vi.fn(async () => ({
    body: null,
    summary: { applied: false, reason: 'disabled' },
  })),
}));

// T-F3: stand-in for the privacy filter — replaces the operator term with a
// one-char alias (exact -6 bytes per occurrence) and reports a truthy filter
// so the response-side restoration path is exercised.
vi.mock('../../open-sse/utils/privacyFilter.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    redactOutbound: vi.fn((body) => {
      if (!body) return null;
      mocks.privacyObserved.before = JSON.stringify(body);
      let changed = false;
      const scrub = (text) => {
        if (typeof text === 'string' && text.includes('SEEKRET')) {
          changed = true;
          return text.split('SEEKRET').join('R');
        }
        return text;
      };
      for (const m of body.messages || []) {
        if (typeof m?.content === 'string') {
          m.content = scrub(m.content);
        } else if (Array.isArray(m?.content)) {
          for (const part of m.content) {
            if (typeof part?.text === 'string') part.text = scrub(part.text);
          }
        }
      }
      mocks.privacyObserved.after = JSON.stringify(body);
      if (!changed) return null;
      return { size: 1, aliases: () => [], restore: (t) => t, restoreJson: (t) => t };
    }),
  };
});

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');

function makeExecutorRes() {
  // openai is forceStream upstream: the wire speaks SSE with a [DONE]
  // terminal and a usage-bearing final chunk.
  const sse =
    `data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
    'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n' +
    'data: [DONE]\n\n';
  return {
    response: new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  };
}

// t1: RTK compresses 900 -> 100. t2: left fat for the memory pruner
// (5000 -> ~895 via head/tail truncation + notice). t3: headroom
// compresses 900 -> 100. keepRecentTurns=1 keeps only t3 intact, so the
// memory stage has t2 to prune.
const fatBody = () => ({
  model: 'openai/gpt-4o',
  stream: false,
  messages: [
    { role: 'user', content: 'run the tools' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'a'.repeat(900) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'b'.repeat(5000) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c3', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c3', content: 'c'.repeat(900) },
  ],
});

const memorySettings = {
  memoryToolPruningEnabled: true,
  memoryMaxToolTurnsKeepFull: 1,
  memoryMaxHistoricalToolChars: 800,
  // Pruning is demand-driven (toolPruner.js): with no overflow the history is
  // left alone. A window this small puts these bodies over budget so the pruner
  // runs, which is the behaviour these assertions are about. Tighter than the
  // sibling suites because headroom shrinks the body before memory measures it,
  // so a 2000-token window left a deficit too small to clear the -3000 floor.
  memoryContextWindowOverride: 1000,
  memoryMediaPruningEnabled: false,
  memoryHandoffEnabled: false,
  memoryContextCompactionEnabled: false,
};

let consoleLines;
let consoleSpy;

beforeEach(() => {
  mocks.executeMock.mockReset();
  mocks.executeMock.mockImplementation(async () => makeExecutorRes());
  mocks.headroom.compressWithHeadroom.mockReset();
  mocks.headroom.compressWithHeadroom.mockImplementation(async () => null);
  mocks.rtkObserved.before = mocks.rtkObserved.after = null;
  mocks.headroomObserved.before = mocks.headroomObserved.after = null;
  mocks.privacyObserved.before = mocks.privacyObserved.after = null;
  mocks.dispatched = null;
  consoleLines = [];
  consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    consoleLines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

function reqLines() {
  return consoleLines.filter((l) => l.includes(' REQ.'));
}
function xformLines() {
  return consoleLines.filter((l) => l.includes(' XFORM.'));
}

async function drive(overrides = {}) {
  const result = await handleChatCore({
    body: fatBody(),
    modelInfo: { provider: 'openai', model: 'gpt-4o' },
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
    connectionId: 'test-conn',
    tokenSaverEnabled: true,
    memorySettings,
    onTokenSaverEvent: vi.fn(),
    requestId: overrides.requestId || 'tele0001',
    ...overrides,
  });
  await result.response.text();
  return result;
}

// Headroom pass-through mock: shrinks tool_call_id "c3" by an exact amount
// and reports honest stats + size diagnostics (the applied-path-code gate).
function shrinkHeadroomMock() {
  return async (body, { enabled, diagnostics } = {}) => {
    if (!enabled) return null;
    mocks.headroomObserved.before = JSON.stringify(body);
    const target = body.messages.find((m) => m?.role === 'tool' && m?.tool_call_id === 'c3');
    let saved = 0;
    if (target && typeof target.content === 'string' && target.content.length === 900) {
      target.content = 'y'.repeat(100);
      saved = 800;
    }
    mocks.headroomObserved.after = JSON.stringify(body);
    if (diagnostics) {
      diagnostics.before = { bodyBytes: mocks.headroomObserved.before.length };
      diagnostics.after = { bodyBytes: mocks.headroomObserved.after.length };
    }
    return { tokens_before: 1000, tokens_after: 900, tokens_saved: 100, bytes_saved: saved };
  };
}

// Independent per-stage byte deltas from mock-observed serializations. Pipeline
// order is rtk, mem, headroom: rtk between the RTK mock's own before/after; mem
// as the body headroom sees on entry minus the body rtk left (mem runs between
// them and is not itself mocked); headroom between its own before/after.
function observedDeltas() {
  const rtk = mocks.rtkObserved.after.length - mocks.rtkObserved.before.length;
  const headroom =
    mocks.headroomObserved.after === null
      ? null
      : mocks.headroomObserved.after.length - mocks.headroomObserved.before.length;
  const mem =
    headroom === null
      ? mocks.dispatched.length - mocks.rtkObserved.after.length
      : mocks.headroomObserved.before.length - mocks.rtkObserved.after.length;
  return { rtk, headroom, mem };
}

function saveFieldOf(line) {
  const m = line.match(/ save=([^\s]+)/);
  return Object.fromEntries(
    m[1]
      .split(',')
      .map((kv) => kv.split(':'))
      .map(([k, v]) => [k, Number(v)])
  );
}

function expectSaveLine(line, deltas) {
  // Stage order matches the pipeline: rtk, mem, headroom.
  const stages = [];
  if (deltas.rtk !== 0) stages.push(`rtk:${deltas.rtk}`);
  if (deltas.mem !== 0) stages.push(`mem:${deltas.mem}`);
  if (deltas.headroom !== null && deltas.headroom !== 0) stages.push(`headroom:${deltas.headroom}`);
  expect(line).toContain(` save=${stages.join(',')} `);
  const total = deltas.rtk + deltas.mem + (deltas.headroom ?? 0);
  expect(line).toMatch(new RegExp(` save_tok=${Math.round(total / 4)}(?:\\s|$)`));
}

describe('token-saver REQ telemetry', () => {
  it('save= arithmetic matches independently recomputed stage byte deltas (headroom enabled)', async () => {
    mocks.headroom.compressWithHeadroom.mockImplementation(shrinkHeadroomMock());
    await drive({ rtkEnabled: true, headroomEnabled: true, requestId: 'tele0100' });
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain(' REQ.ok ');
    const deltas = observedDeltas();
    expect(deltas.rtk).toBe(-800);
    expect(deltas.headroom).toBe(-800);
    expect(deltas.mem).toBeLessThan(-3000);
    expectSaveLine(reqs[0], deltas);
    // the saver path codes ride the REQ line's path= field
    expect(reqs[0]).toMatch(/path=\S*XFORM\.rtk-applied/);
    expect(reqs[0]).toMatch(/path=\S*XFORM\.headroom-applied/);
    expect(reqs[0]).toMatch(/path=\S*XFORM\.mem-pruned/);
  });

  it('save= omits stages that did not run (headroom disabled, memory still prunes)', async () => {
    await drive({ rtkEnabled: true, headroomEnabled: false, requestId: 'tele0101' });
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain(' REQ.ok ');
    const deltas = observedDeltas();
    expect(deltas.headroom).toBe(null);
    expect(deltas.rtk).toBe(-800);
    expect(deltas.mem).toBeLessThan(-3000);
    expectSaveLine(reqs[0], deltas);
    expect(reqs[0]).not.toContain('headroom:');
    expect(reqs[0]).toMatch(/path=\S*XFORM\.rtk-applied/);
    expect(reqs[0]).toMatch(/path=\S*XFORM\.mem-pruned/);
  });

  it('ce= grows on an appended turn and drops to near zero when history is rewritten', async () => {
    const base = {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'first question' }],
    };

    await drive({ body: structuredClone(base), sid: 'telem-ce-01', requestId: 'tele0200' });
    let reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toContain('ce=');

    const appended = structuredClone(base);
    appended.messages.push({ role: 'assistant', content: 'answer' });
    appended.messages.push({ role: 'user', content: 'second question' });
    // clone BEFORE the drive: handleChatCore flips body.stream to true in
    // place (passthrough), and a clone taken afterwards would carry it and
    // route request 3 to the streaming path, which has no REQ line here
    const rewritten = structuredClone(appended);
    rewritten.messages[0] = { role: 'user', content: 'completely different opening line' };

    await drive({ body: appended, sid: 'telem-ce-01', requestId: 'tele0201' });
    reqs = reqLines();
    expect(reqs).toHaveLength(2);
    const ce2 = Number(reqs[1].match(/ ce=(\d+)/)[1]);
    expect(ce2).toBeGreaterThan(60);

    await drive({ body: rewritten, sid: 'telem-ce-01', requestId: 'tele0202' });
    reqs = reqLines();
    expect(reqs).toHaveLength(3);
    const ce3 = Number(reqs[2].match(/ ce=(\d+)/)[1]);
    expect(ce3).toBeLessThan(ce2);
    // divergence inside the first message: only the JSON envelope survives
    expect(ce3).toBeLessThan(80);
  });

  it('saver-guard fires once when a stage grows the body by more than 5% of entry', async () => {
    mocks.headroom.compressWithHeadroom.mockImplementation(async (body, { enabled } = {}) => {
      if (!enabled) return null;
      body.messages[0].content += 'z'.repeat(3000);
      return { tokens_before: 100, tokens_after: 800, tokens_saved: -700 };
    });
    await drive({ rtkEnabled: false, headroomEnabled: true, requestId: 'tele0300' });
    const guards = xformLines().filter((l) => l.includes('saver-guard'));
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatch(/XFORM\.saver-guard rid=tele0300 stage=headroom in=\d+ out=\d+/);
    // growth appears honestly in save= (positive, not folded away), and
    // save_tok= is the rounded sum of ALL stage deltas including mem. mem
    // runs before headroom now, so it is free to appear ahead of it here;
    // headroom's own +3000 growth must still land exactly, last.
    const reqs = reqLines();
    const stages = saveFieldOf(reqs[0]);
    expect(stages.headroom).toBe(3000);
    expect(reqs[0]).toMatch(/ save=(?:mem:-?\d+,)?headroom:3000(?:\s|$)/);
    const total = Object.values(stages).reduce((a, b) => a + b, 0);
    expect(reqs[0]).toMatch(new RegExp(` save_tok=${Math.round(total / 4)}(?:\\s|$)`));
  });

  it('saver event rows carry signed bytesSaved, saveTokEst and ce', async () => {
    const onTokenSaverEvent = vi.fn();
    mocks.headroom.compressWithHeadroom.mockImplementation(shrinkHeadroomMock());
    // warm the sid: ce is absent on first sight by design, so seed one
    // request before the one whose event rows we assert on
    await drive({ sid: 'telem-ce-02', requestId: 'tele0399' });
    await drive({
      rtkEnabled: true,
      headroomEnabled: true,
      sid: 'telem-ce-02',
      onTokenSaverEvent,
      requestId: 'tele0400',
    });
    const rtkRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === 'rtk')?.[0];
    const headroomRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === 'headroom')?.[0];
    const deltas = observedDeltas();
    expect(rtkRow.bytesSaved).toBe(deltas.rtk);
    expect(rtkRow.saveTokEst).toBe(Math.round(deltas.rtk / 4));
    expect(typeof rtkRow.ce).toBe('number');
    expect(headroomRow.bytesSaved).toBe(deltas.headroom);
    expect(headroomRow.ce).toBe(rtkRow.ce);
  });

  it('T-F1: ce= reports the exact shared-prefix length, not a 64KB floor', async () => {
    // Common prefix length in bytes between two ASCII strings.
    const commonPrefixLen = (a, b) => {
      const n = Math.min(a.length, b.length);
      let i = 0;
      while (i < n && a[i] === b[i]) i++;
      return i;
    };
    const big = 'p'.repeat(100 * 1024);
    const base = {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: big }],
    };
    await drive({ body: structuredClone(base), sid: 'telem-ce-64k', requestId: 'tele0500' });
    const dispatched1 = mocks.dispatched;
    let reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toContain('ce=');

    // request 2: appends a turn. Bodies share more than 64KB, and the exact
    // shared prefix (not a 65536 floor) is what ce= must report.
    const appended = structuredClone(base);
    appended.messages.push({ role: 'assistant', content: 'a' });
    // clone BEFORE the drive: handleChatCore flips body.stream to true in
    // place (passthrough), and a clone taken afterwards would carry it and
    // route request 3 to the streaming path, which has no REQ line here
    const rewritten = structuredClone(appended);
    rewritten.messages[0] = { role: 'user', content: 'completely different opening line' };

    await drive({ body: appended, sid: 'telem-ce-64k', requestId: 'tele0501' });
    const dispatched2 = mocks.dispatched;
    reqs = reqLines();
    expect(reqs).toHaveLength(2);
    const ce2 = Number(reqs[1].match(/ ce=(\d+)/)[1]);
    const sharedPrefix = commonPrefixLen(dispatched1, dispatched2);
    expect(sharedPrefix).toBeGreaterThan(65536);
    expect(ce2).toBe(sharedPrefix);

    // request 3: rewrites the early (only) turn. The divergence lands inside
    // the first block, so the reported epoch is a whole-block multiple below
    // half of request 2's dispatched size.
    await drive({ body: rewritten, sid: 'telem-ce-64k', requestId: 'tele0502' });
    reqs = reqLines();
    expect(reqs).toHaveLength(3);
    const ce3 = Number(reqs[2].match(/ ce=(\d+)/)[1]);
    expect(ce3 % 65536).toBe(0);
    expect(ce3).toBeLessThan(dispatched2.length / 2);
  });

  it('T-F3: privacy bytes are measured as their own stage, not attributed to headroom', async () => {
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'hello SEEKRET world' }],
    };
    await drive({
      body,
      modelInfo: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
      privacyEnabled: true,
      privacyTerms: ['SEEKRET'],
      rtkEnabled: false,
      headroomEnabled: true, // runs but mutates nothing
      memorySettings: null,
      requestId: 'tele0700',
    });
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    const privacyDelta = mocks.privacyObserved.after.length - mocks.privacyObserved.before.length;
    expect(privacyDelta).toBe(-6);
    expect(reqs[0]).toMatch(/ save=privacy:-6/);
    // headroom ran but changed nothing, so it must not absorb privacy bytes
    expect(reqs[0]).not.toContain('headroom:');
    expect(xformLines().filter((l) => l.includes('saver-guard'))).toHaveLength(0);
  });

  it('T-F2: the final stage closes the ledger — stage deltas sum to dispatched minus ledger entry bytes', async () => {
    mocks.headroom.compressWithHeadroom.mockImplementation(shrinkHeadroomMock());
    await drive({ rtkEnabled: true, headroomEnabled: true, requestId: 'tele0800' });
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    const stages = saveFieldOf(reqs[0]);
    const sum = Object.values(stages).reduce((a, b) => a + b, 0);
    // the ledger opens at the first stage boundary (post-translation, observed
    // inside the rtk mock) and the final measure closes it at dispatch: the
    // per-stage deltas must telescope to exactly the dispatched delta
    expect(mocks.rtkObserved.before).not.toBeNull();
    expect(sum).toBe(mocks.dispatched.length - mocks.rtkObserved.before.length);
  });
  it('inject stage emits an event row reporting its growth honestly', async () => {
    const onTokenSaverEvent = vi.fn();
    await drive({
      cavemanEnabled: true,
      cavemanLevel: 'ultra',
      sid: 'telem-ce-04',
      requestId: 'tele0403',
      onTokenSaverEvent,
    });
    const injectRow = onTokenSaverEvent.mock.calls.find((c) => c[0]?.saver === 'inject')?.[0];
    expect(injectRow).toBeDefined();
    expect(injectRow.bytesSaved).toBeGreaterThan(0);
    expect(injectRow.saveTokEst).toBe(Math.round(injectRow.bytesSaved / 4));
  });
});
