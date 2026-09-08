import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Formatting and signed-ledger assertions observe the transport boundary;
// async-log-output.test.js separately verifies native bounded stdout writes.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({ logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}) }));

// Composed-pipeline no-loss proof: RTK + headroom + caveman injection + memory
// tool pruning + context compaction + cache anchoring all run on one rich
// Claude-format body routed through native passthrough (claude-cli UA). Asserts
// the invariants a saver pipeline must never break: tool_use/tool_result
// pairing, is_error evidence un-pruned, client cache_control blocks and
// thinking signatures byte-identical, recent turns byte-identical, the
// compactor's recent-window contract, honest save= arithmetic (every byte
// recomputed here from mock-observed serializations), dispatched strictly
// smaller than entry, and no saver-guard phantom-growth line.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  headroom: {
    compressWithHeadroom: vi.fn(async () => null),
    // like the real module: a line when stats exist, null otherwise
    formatHeadroomLog: vi.fn((stats) => (stats ? 'headroom: applied' : null)),
    formatHeadroomSizeLog: vi.fn(() => ''),
    isHeadroomPhantomSavings: vi.fn(() => false),
  },
  pxpipeObserved: null,
  dispatched: null,
  // stage snapshots observed independently inside the mocked boundaries
  rtkObserved: { before: null, after: null },
  headroomObserved: { before: null, after: null },
}));

vi.mock('../../open-sse/executors/index.js', () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: (...args) => {
      // capture the body the pipeline dispatched (post-saver, post-anchor)
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

// RTK stands in for the real compressor: shrinks ONE Claude tool_result block
// (tool_use_id "tu-1", 2000 -> 200 chars) and reports one hit.
vi.mock('../../open-sse/rtk/index.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
      if (!enabled || !body?.messages) return null;
      mocks.rtkObserved.before = JSON.stringify(body);
      let shrunk = false;
      for (const msg of body.messages) {
        if (!Array.isArray(msg?.content)) continue;
        for (const block of msg.content) {
          if (
            block?.type === 'tool_result' &&
            block.tool_use_id === 'tu-1' &&
            typeof block.content === 'string' &&
            block.content.length === 2000
          ) {
            block.content = 'f'.repeat(200);
            shrunk = true;
          }
        }
      }
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

// PXPIPE is only a pipeline-order observation point here: it runs after
// caveman injection and before the memory stage, so its input snapshot
// isolates the injection delta from the memory delta.
vi.mock('../../open-sse/rtk/pxpipe.js', () => ({
  compressWithPxpipe: vi.fn(async (body) => {
    mocks.pxpipeObserved = JSON.stringify(body);
    return { body: null, summary: { applied: false, reason: 'disabled' } };
  }),
}));

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');

// Anthropic validates thinking signatures (base64, first decoded byte 0x12);
// the pipeline drops blocks with invalid ones, so these must look real.
const mkSig = (tag) => Buffer.from([0x12, ...Buffer.from(tag)]).toString('base64');

// Entry body: 11 conversational messages, ~48KB. Messages 0-8 are history the
// compactor will summarize away; messages 9-10 are the recent window that
// every stage must leave byte-identical.
const richBody = () => ({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  stream: false,
  system: [
    { type: 'text', text: 'You are a careful engineer.', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'read a file',
      type: 'custom', // pre-stamped so defaultClaudeToolType is an identity
      input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Goal: fix the parser bug in src/lexer.js. There was an error in the build; the todo is still pending and we decided to keep the budget small.',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan: read the lexer first', signature: mkSig('sig-A') },
        { type: 'text', text: 'Reading the lexer now.' },
        { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'src/lexer.js' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'F'.repeat(2000) }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The lexer is long; grepping for the token loop.' },
        { type: 'tool_use', id: 'tu-2', name: 'read_file', input: { path: 'src/lexer.js' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'G'.repeat(24000) }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Found the loop; patching.' },
        { type: 'tool_use', id: 'tu-3', name: 'read_file', input: { path: 'src/lexer.js' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'H'.repeat(1000) }],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'the patch failed; inspect stderr',
          signature: mkSig('sig-B'),
        },
        { type: 'text', text: 'The edit failed; reading the error.' },
        { type: 'tool_use', id: 'tu-4', name: 'read_file', input: { path: '/tmp/x' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-4', content: 'I'.repeat(8000) }],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'stderr says the regression is in the parser',
          signature: mkSig('sig-C'),
        },
        { type: 'text', text: 'Here is the error summary.', cache_control: { type: 'ephemeral' } },
        { type: 'tool_use', id: 'tu-5', name: 'read_file', input: { path: '/tmp/err' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-5', content: 'E'.repeat(3000), is_error: true },
      ],
    },
  ],
});

const memorySettings = {
  memoryToolPruningEnabled: true,
  memoryMaxToolTurnsKeepFull: 0, // every tool turn is historical: exercises the is_error skip
  memoryMaxHistoricalToolChars: 800,
  // Pruning is demand-driven (toolPruner.js): with no overflow the history is
  // left alone. A window this small puts these bodies over budget so the pruner
  // runs, which is the behaviour these assertions are about.
  memoryContextWindowOverride: 2000,
  memoryMediaPruningEnabled: false,
  memoryHandoffEnabled: false,
  memoryCompactionEnabled: true,
  memoryCompactionThresholdTokens: 500,
  memoryRecentTurnsToKeep: 2,
};

const CLIENT_HEADERS = { 'user-agent': 'claude-cli/1.0.0 (external, cli)' };

let consoleLines;
let consoleSpy;

beforeEach(() => {
  mocks.executeMock.mockReset();
  mocks.executeMock.mockImplementation(async () => ({
    response: new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ),
    url: 'https://api.anthropic.com/v1/messages',
    headers: {},
    transformedBody: null,
  }));
  mocks.headroom.compressWithHeadroom.mockReset();
  // headroom pass-through that shrinks tool_result "tu-3" to 100 chars and
  // reports size diagnostics (the applied-path-code gate). Mem now runs
  // BEFORE headroom, so tu-3's content may already be head/tail-truncated
  // (still starting with "H") or gone entirely (compacted away) by the time
  // this runs; match on tool_use_id plus a content prefix rather than an
  // exact original length so this still fires against whatever mem left.
  mocks.headroom.compressWithHeadroom.mockImplementation(
    async (body, { enabled, diagnostics } = {}) => {
      if (!enabled) return null;
      mocks.headroomObserved.before = JSON.stringify(body);
      let saved = 0;
      for (const msg of body.messages) {
        if (!Array.isArray(msg?.content)) continue;
        for (const block of msg.content) {
          if (
            block?.type === 'tool_result' &&
            block.tool_use_id === 'tu-3' &&
            typeof block.content === 'string' &&
            block.content.startsWith('H')
          ) {
            saved = block.content.length - 100;
            block.content = 'h'.repeat(100);
          }
        }
      }
      mocks.headroomObserved.after = JSON.stringify(body);
      if (diagnostics) {
        diagnostics.before = { bodyBytes: mocks.headroomObserved.before.length };
        diagnostics.after = { bodyBytes: mocks.headroomObserved.after.length };
      }
      return { tokens_before: 500, tokens_after: 275, tokens_saved: 225, bytes_saved: saved };
    }
  );
  mocks.rtkObserved.before = mocks.rtkObserved.after = null;
  mocks.headroomObserved.before = mocks.headroomObserved.after = null;
  mocks.pxpipeObserved = null;
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
  const body = richBody();
  const entry = JSON.stringify(body);
  const result = await handleChatCore({
    body,
    modelInfo: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
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
    clientRawRequest: { endpoint: '/v1/messages', body: {}, headers: CLIENT_HEADERS },
    memorySettings,
    onTokenSaverEvent: vi.fn(),
    requestId: 'comp0001',
    ...overrides,
  });
  await result.response.text();
  return { entry, entryBytes: entry.length };
}

describe('composed saver pipeline invariants', () => {
  it('savers run in order, recent window survives byte-identical, save= is honest', async () => {
    const { entry, entryBytes } = await drive({
      rtkEnabled: true,
      headroomEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: 'lite',
      pxpipeEnabled: true,
      requestId: 'comp0100',
    });

    // -- stage snapshots, observed independently of the implementation ----
    // Pipeline order is rtk, inject, pxpipe (observation point only), mem,
    // headroom: mem now runs BEFORE headroom, so its boundary is the body
    // headroom sees on entry, and headroom's own before/after brackets it.
    const rtk = mocks.rtkObserved.after.length - mocks.rtkObserved.before.length;
    const inject = mocks.pxpipeObserved.length - mocks.rtkObserved.after.length;
    const mem = mocks.headroomObserved.before.length - mocks.pxpipeObserved.length;
    const headroom = mocks.headroomObserved.after.length - mocks.headroomObserved.before.length;
    expect(rtk).toBe(-1800);
    expect(inject).toBeGreaterThan(0); // caveman system prompt splice (~1.9KB)
    expect(mem).toBeLessThan(-30000); // pruner + compactor over a ~48KB body
    // compaction (part of mem) has already folded tu-3 into the summary note
    // by the time headroom runs, so headroom's tu-3 target is gone and it
    // finds nothing left to shrink.
    expect(headroom).toBe(0);

    // -- REQ.ok line: honest save= / save_tok=, folded path codes ----------
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain(' REQ.ok ');
    const total = rtk + inject + mem + headroom;
    expect(reqs[0]).toContain(` save=rtk:${rtk},inject:${inject},mem:${mem} `);
    expect(reqs[0]).not.toContain('headroom:');
    expect(reqs[0]).toMatch(new RegExp(` save_tok=${Math.round(total / 4)}(?:\\s|$)`));
    // 60-char path value cap keeps the earliest forks; mem-pruned and
    // compact-applied are dropped from the TAIL (they are proven via the
    // dispatched body below, not via path=)
    expect(reqs[0]).toMatch(/path=\S*XFORM\.rtk-applied/);
    // headroom's mock reports stats unconditionally when enabled, even when
    // it found nothing to shrink, so the applied path code still fires.
    expect(reqs[0]).toMatch(/path=\S*XFORM\.headroom-applied/);
    expect(reqs[0]).toMatch(/path=\S*XFORM\.injected/);

    // -- no phantom growth anywhere: injection stays under the 5% guard ----
    expect(xformLines().filter((l) => l.includes('saver-guard'))).toHaveLength(0);

    // -- dispatched strictly smaller than entry ---------------------------
    expect(mocks.dispatched.length).toBeLessThan(entryBytes);

    // -- final body structure: compactor contract --------------------------
    // Claude targets cannot carry role:"system" inside messages[], so the
    // summary+notice ship as ONE user-role note under the midPrefixInject
    // "[tokenproxy context note]" label (a claude body rejected by the API is
    // worse than a labeled synthetic user note).
    const dispatched = JSON.parse(mocks.dispatched);
    const entryBody = JSON.parse(entry);
    const msgs = dispatched.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0].content).toContain('[tokenproxy context note] ');
    expect(msgs[0].content).toContain(
      '[Historical Context Summary by tokenproxy Memory Optimizer]'
    );
    expect(typeof msgs[0].content).toBe('string');

    // recent window: byte-identical to the entry tail
    expect(JSON.stringify(msgs[1])).toBe(JSON.stringify(entryBody.messages[9]));
    expect(JSON.stringify(msgs[2])).toBe(JSON.stringify(entryBody.messages[10]));

    // tool_use/tool_result pairing in the survivors
    const toolUseIds = new Set();
    const toolResultIds = new Set();
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === 'tool_use') toolUseIds.add(block.id);
        if (block?.type === 'tool_result') toolResultIds.add(block.tool_use_id);
      }
    }
    expect([...toolUseIds].sort()).toEqual([...toolResultIds].sort());
    expect(toolUseIds.has('tu-5')).toBe(true);

    // is_error evidence: full 3000 chars, flag intact
    const errBlock = msgs[2].content[0];
    expect(errBlock.is_error).toBe(true);
    expect(errBlock.content).toBe('E'.repeat(3000));

    // thinking signature intact in the recent assistant turn
    const thinking = msgs[1].content.find((b) => b.type === 'thinking');
    expect(thinking.signature).toBe(mkSig('sig-C'));
    expect(thinking.thinking).toBe('stderr says the regression is in the parser');

    // client cache_control blocks byte-identical after anchoring ran last:
    // system anchor survived (caveman spliced BEFORE it), tool anchor
    // survived, and the recent assistant text block anchor survived
    const sysAnchor = dispatched.system.find((b) => b.text === 'You are a careful engineer.');
    expect(sysAnchor.cache_control).toEqual({ type: 'ephemeral' });
    expect(dispatched.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const textBlock = msgs[1].content.find((b) => b.type === 'text');
    expect(textBlock.cache_control).toEqual({ type: 'ephemeral' });

    // -- compaction replaced the history: RTK/headroom/pruner effects all --
    // landed in the compacted-away range, so the fat content and the prune
    // notices are gone from the final body by design
    expect(mocks.dispatched).not.toContain('G'.repeat(24000));
    expect(mocks.dispatched).not.toContain('I'.repeat(8000));
    expect(mocks.dispatched).not.toContain('F'.repeat(2000));
    expect(mocks.dispatched).not.toContain('H'.repeat(1000));
  });

  it('same pipeline without compaction: pruned turns keep structure and notice', async () => {
    const { entry } = await drive({
      rtkEnabled: true,
      headroomEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: 'lite',
      pxpipeEnabled: true,
      memorySettings: { ...memorySettings, memoryCompactionEnabled: false },
      requestId: 'comp0110',
    });

    // every message survives; recent window byte-identical to the entry tail
    const dispatched = JSON.parse(mocks.dispatched);
    const entryBody = JSON.parse(entry);
    expect(dispatched.messages).toHaveLength(11);
    expect(JSON.stringify(dispatched.messages[9])).toBe(JSON.stringify(entryBody.messages[9]));
    expect(JSON.stringify(dispatched.messages[10])).toBe(JSON.stringify(entryBody.messages[10]));

    // pruning effects visible in the final body: notices in, fat content out,
    // is_error evidence untouched
    const fat = JSON.stringify(dispatched.messages[4]);
    expect(fat).toContain('Tool output truncated by tokenproxy memory optimizer');
    expect(fat).not.toContain('G'.repeat(24000));
    expect(JSON.stringify(dispatched.messages[8])).not.toContain('I'.repeat(8000));
    expect(JSON.stringify(dispatched.messages[2])).toContain('f'.repeat(200)); // RTK
    expect(JSON.stringify(dispatched.messages[6])).toContain('h'.repeat(100)); // headroom
    const err = dispatched.messages[10].content[0];
    expect(err.is_error).toBe(true);
    expect(err.content).toBe('E'.repeat(3000));

    // honest save= against independently observed stage deltas. Pipeline
    // order is rtk, inject, pxpipe (observation point), mem, headroom.
    const rtk = mocks.rtkObserved.after.length - mocks.rtkObserved.before.length;
    const inject = mocks.pxpipeObserved.length - mocks.rtkObserved.after.length;
    const mem = mocks.headroomObserved.before.length - mocks.pxpipeObserved.length;
    const headroom = mocks.headroomObserved.after.length - mocks.headroomObserved.before.length;
    expect(rtk).toBe(-1800);
    // tu-3 survives (compaction is off), but mem's tool-pruner truncates it
    // before headroom ever sees it, so headroom's savings are off whatever
    // size mem left rather than the original 1000 chars.
    expect(headroom).toBeLessThan(0);
    const total = rtk + inject + mem + headroom;
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toContain(` save=rtk:${rtk},inject:${inject},mem:${mem},headroom:${headroom} `);
    expect(reqs[0]).toMatch(new RegExp(` save_tok=${Math.round(total / 4)}(?:\\s|$)`));
    expect(xformLines().filter((l) => l.includes('saver-guard'))).toHaveLength(0);
  });

  it('token-saver opt-out header: dispatched body equals entry, no save= fields', async () => {
    const { entry } = await drive({
      rtkEnabled: true,
      headroomEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: 'lite',
      pxpipeEnabled: true,
      clientRawRequest: {
        endpoint: '/v1/messages',
        body: {},
        headers: { ...CLIENT_HEADERS, 'x-tokenproxy-token-saver': 'off' },
      },
      requestId: 'comp0200',
    });
    // saver fully off: the dispatched body is byte-identical to the entry
    expect(mocks.dispatched).toBe(entry);
    const reqs = reqLines();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toContain('save=');
    expect(reqs[0]).not.toContain('save_tok=');
    expect(reqs[0]).not.toContain('ce=');
  });
});
