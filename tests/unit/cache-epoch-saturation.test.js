import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// trackCacheEpoch (chatCore.js ~L212) keeps only the first CE_PREFIX_BYTES
// (64 KiB) of the previous request's serialized body and reports ce = shared
// prefix length. For any body over 64 KiB, ce saturates at 65536 even when the
// two bodies are byte-identical. compactHint (~L1246) fires when
// ce < prevBytes * 0.5, so a session whose bodies exceed 128 KiB gets a false
// "compact your context" hint on every turn, no matter the actual content.

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  dispatched: null,
}));

vi.mock('../../open-sse/executors/index.js', () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: (...args) => {
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

vi.mock('../../open-sse/rtk/index.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    compressMessages: vi.fn((body, enabled) => {
      if (!enabled) return null;
      return { hits: [], bytesBefore: 0, bytesAfter: 0 };
    }),
  };
});

vi.mock('../../open-sse/rtk/headroom.js', () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => null),
  formatHeadroomSizeLog: vi.fn(() => ''),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock('../../open-sse/rtk/pxpipe.js', () => ({
  compressWithPxpipe: vi.fn(async () => ({
    body: null,
    summary: { applied: false, reason: 'disabled' },
  })),
}));

vi.mock('../../open-sse/services/memory/index.js', () => ({
  applyMemoryEnhancements: vi.fn(async (body) => ({ body, stats: {} })),
}));

vi.mock('@/lib/usageDb.js', () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
const { readContextStatus } =
  await import('../../open-sse/handlers/chatCore/contextStatusStore.js');

function anthropicExecutorRes() {
  return {
    response: new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ),
    url: 'https://api.anthropic.com/v1/messages',
    headers: {},
    transformedBody: null,
  };
}

// SID_RE in contextStatusStore.js requires exactly 8 lowercase hex chars;
// a dash-bearing id like "sid-sat-1" is silently rejected by writeContextStatus
// and readContextStatus would return null regardless of the ce bug, so this
// uses a conforming session id.
const SID = '5a751000';

beforeEach(() => {
  mocks.executeMock.mockReset();
  mocks.dispatched = null;
  mocks.executeMock.mockImplementation(async () => anthropicExecutorRes());
  globalThis.fetch = vi.fn(async () => {
    throw new Error('unexpected fetch');
  });
});

function bigClaudeBody() {
  // ~300,000 characters of repeated words -> well past the 64 KiB prefix cap
  // and past the 128 KiB threshold where compactHint always fires on an
  // unchanged body.
  const text = 'repeated words padding filler '.repeat(10000);
  return {
    model: 'claude-opus-5',
    max_tokens: 64,
    stream: false,
    messages: [{ role: 'user', content: text }],
  };
}

async function drive(requestId) {
  const result = await handleChatCore({
    body: bigClaudeBody(),
    modelInfo: { provider: 'claude', model: 'claude-opus-5' },
    credentials: { apiKey: 'sk-fake-test', providerSpecificData: {} },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      line: vi.fn(),
      tagForSession: () => 'TAG',
      nextTag: () => 'TAG',
      fmtThink: () => null,
    },
    connectionId: 'ce-conn',
    rtkEnabled: false,
    schemaDistillEnabled: false,
    thinkingStripEnabled: false,
    queryAwareCompressionEnabled: false,
    pairDropEnabled: false,
    embedReorderEnabled: false,
    midPrefixInjectEnabled: false,
    privacyEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    memorySettings: undefined,
    clientRawRequest: { headers: {} },
    sid: SID,
    requestId,
  });
  await result.response.text();
  return result;
}

describe('cache-epoch saturation on oversized bodies (#trackCacheEpoch)', () => {
  it('byte-identical bodies over 128 KiB should not report a saturated ce or a false compact hint', async () => {
    await drive('csat0001');
    // Same body serialized again on the second call.
    await drive('csat0002');

    const entry = await readContextStatus(SID);
    expect(entry).not.toBeNull();

    const finalSerialized = JSON.stringify(JSON.parse(mocks.dispatched));
    const finalBytes = Buffer.byteLength(finalSerialized);

    console.log(`ctxTokens recorded: ${entry.ctxTokens}`);
    console.log(`real serialized body byte length: ${finalBytes}`);

    // ce should reflect the true shared prefix (the full body, since the two
    // requests are byte-identical), not the 64 KiB collection cap.
    expect(entry.ceBytes).toBe(finalBytes);
    // The body did not shrink at all, so no compaction hint should fire.
    expect(entry.compactHint).not.toBe(true);
    // The provider-billed prompt size of the last completed request lands
    // on the same entry (input + cache read + cache creation from the
    // executor's usage), which is the number an agent should size against.
    expect(entry.ctxTokensActual).toBe(8);
  });
});
