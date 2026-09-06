// Covers two chatCore.js internals the handler suites drive past without
// exercising: the per-session cache-epoch tracker (trackCacheEpoch, reached by
// passing a sid) and request isolation's non-messages branches, which
// copy `input` and `conversationState` so an account-fallback retry never
// re-compresses a body it already compressed (#3566).
//
// The executor is mocked, so no upstream is contacted; proxyFetch is mocked too
// because installGlobalProxyFetch would otherwise replace the stubbed fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function executorResult() {
  return {
    response: new Response(
      JSON.stringify({
        id: 'chatcmpl-x',
        object: 'chat.completion',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ),
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {},
    transformedBody: null,
  };
}

function baseArgs(overrides = {}) {
  return {
    body: {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    },
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
    connectionId: 'conn-ce-1',
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { headers: {}, body: {} },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchedBodies.length = 0;
  mocks.executeMock.mockImplementation(async (args) => {
    mocks.dispatchedBodies.push(args?.body);
    return executorResult();
  });
});

describe('cache-epoch tracking per session', () => {
  // The tracker is keyed by sid and only runs when one is supplied, so a
  // request without a sid must leave no residue for the next one to match on.
  const sid = 'aaaa1111';

  it("reports no shared prefix on a session's first request", async () => {
    const res = await handleChatCore(baseArgs({ sid, connectionId: 'conn-ce-first' }));
    expect(res).toBeTruthy();
    // Nothing to compare against yet: the assertion is simply that the first
    // request completes and primes the tracker for the second.
    expect(mocks.executeMock).toHaveBeenCalledTimes(1);
  });

  it('finds a shared prefix when the next request extends the previous body', async () => {
    const sid2 = 'bbbb2222';
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      // Push the body past one 64 KiB block so the tracker's block digests,
      // not only its raw tail, take part in the comparison.
      content: `turn ${i} ${'y'.repeat(4000)}`,
    }));

    await handleChatCore(
      baseArgs({ sid: sid2, body: { model: 'openai/gpt-4o', stream: false, messages: history } })
    );
    // Append one turn: the shared prefix is everything before it.
    const extended = [...history, { role: 'user', content: 'one more turn' }];
    await handleChatCore(
      baseArgs({ sid: sid2, body: { model: 'openai/gpt-4o', stream: false, messages: extended } })
    );

    expect(mocks.executeMock).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.dispatchedBodies;
    expect(JSON.stringify(second).length).toBeGreaterThan(JSON.stringify(first).length);
  });

  it('handles a rewritten history that shares no prefix with the previous body', async () => {
    const sid3 = 'cccc3333';
    await handleChatCore(
      baseArgs({
        sid: sid3,
        body: {
          model: 'openai/gpt-4o',
          stream: false,
          messages: [{ role: 'user', content: 'z'.repeat(90_000) }],
        },
      })
    );
    // A completely different first block forces the digest comparison to stop
    // at zero rather than falling into the raw-tail comparison.
    await handleChatCore(
      baseArgs({
        sid: sid3,
        body: {
          model: 'openai/gpt-4o',
          stream: false,
          messages: [{ role: 'user', content: 'q'.repeat(90_000) }],
        },
      })
    );
    expect(mocks.executeMock).toHaveBeenCalledTimes(2);
  });

  it('shrinking a session body below half its previous size still dispatches', async () => {
    const sid4 = 'dddd4444';
    await handleChatCore(
      baseArgs({
        sid: sid4,
        body: {
          model: 'openai/gpt-4o',
          stream: false,
          messages: [{ role: 'user', content: 'w'.repeat(200_000) }],
        },
      })
    );
    await handleChatCore(
      baseArgs({
        sid: sid4,
        body: { model: 'openai/gpt-4o', stream: false, messages: [{ role: 'user', content: 'w' }] },
      })
    );
    expect(mocks.executeMock).toHaveBeenCalledTimes(2);
  });
});

describe('progressive tool disclosure', () => {
  // Both stages sit behind the token-saver opt-out and behind their own
  // enable flags, and both mutate translatedBody.tools before dispatch. The
  // dispatched body is what the assertions read, so the effect is observed
  // where it matters rather than through a log line.
  // BM25 disclosure only ever trims MCP-namespaced tools: extractPinnedNames
  // in toolDisclosure.js pins every name that does NOT start with mcp__,
  // because a client's own tools are called on nearly every turn and
  // appending one later rewrites the provider's whole cached prefix. So the
  // fixture takes a prefix, and the two shapes are asserted separately.
  function toolsBody(count, { prefix = 'tool_', ...extra } = {}) {
    return {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'search the repository for a file' }],
      tools: Array.from({ length: count }, (_, i) => ({
        type: 'function',
        function: {
          name: `${prefix}${i}`,
          description: `does thing ${i}`,
          parameters: { type: 'object' },
        },
      })),
      ...extra,
    };
  }

  function dispatchedToolNames() {
    const body = mocks.dispatchedBodies.at(-1);
    return (body?.tools || []).map((t) => t.function?.name || t.name);
  }

  it('drops tools the static filter excludes', async () => {
    await handleChatCore(
      baseArgs({
        body: toolsBody(6),
        sid: 'cccc9999',
        toolDisclosure: { filterEnabled: true, excludeTools: ['tool_0', 'tool_1'] },
      })
    );
    const names = dispatchedToolNames();
    expect(names).not.toContain('tool_0');
    expect(names).not.toContain('tool_1');
    expect(names).toContain('tool_2');
  });

  it('leaves the tool list alone when the filter excludes nothing', async () => {
    await handleChatCore(
      baseArgs({
        body: toolsBody(4),
        sid: 'dddd1010',
        toolDisclosure: { filterEnabled: true, excludeTools: ['no_such_tool'] },
      })
    );
    expect(dispatchedToolNames()).toHaveLength(4);
  });

  it('trims an MCP catalogue to maxTools once BM25 disclosure is on', async () => {
    await handleChatCore(
      baseArgs({
        body: toolsBody(30, { prefix: 'mcp__srv__search_' }),
        sid: 'eeee1111',
        toolDisclosure: { disclosureEnabled: true, maxTools: 5 },
      })
    );
    expect(dispatchedToolNames().length).toBeLessThanOrEqual(5);
  });

  it("keeps the client's own non-MCP tools whatever maxTools says", async () => {
    // Native tools are pinned by name, so the cap does not apply to them:
    // appending one later would rewrite the provider's cached prompt prefix.
    await handleChatCore(
      baseArgs({
        body: toolsBody(30),
        sid: 'bbbb1414',
        toolDisclosure: { disclosureEnabled: true, maxTools: 5 },
      })
    );
    expect(dispatchedToolNames()).toHaveLength(30);
  });

  it('runs neither stage when the request opts out of token saving', async () => {
    await handleChatCore(
      baseArgs({
        body: toolsBody(30, { prefix: 'mcp__srv__search_' }),
        sid: 'ffff1212',
        toolDisclosure: {
          filterEnabled: true,
          disclosureEnabled: true,
          maxTools: 5,
          excludeTools: ['mcp__srv__search_0'],
        },
        clientRawRequest: { headers: { 'x-tokenproxy-token-saver': 'off' }, body: {} },
      })
    );
    // Opting out must leave every tool in place, the excluded one included.
    expect(dispatchedToolNames()).toHaveLength(30);
    expect(dispatchedToolNames()).toContain('mcp__srv__search_0');
  });

  it('skips both stages when the tools array is empty', async () => {
    await handleChatCore(
      baseArgs({ body: toolsBody(0), sid: 'aaaa1313', toolDisclosure: { filterEnabled: true } })
    );
    expect(dispatchedToolNames()).toEqual([]);
  });
});

describe('request-body isolation', () => {
  // Every attempt owns its JSON containers before translation or compression,
  // because account fallback can re-enter with the same caller body.
  it("does not hand the caller's own message objects to the executor", async () => {
    const body = {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'original text' }],
    };
    const before = JSON.parse(JSON.stringify(body.messages));

    await handleChatCore(baseArgs({ body, rtkEnabled: true, sid: 'eeee5555' }));

    // The caller's array is unchanged whatever the stage did downstream.
    expect(body.messages).toEqual(before);
  });

  it('isolates a Responses-API input array as well as messages', async () => {
    const body = {
      model: 'openai/gpt-4o',
      stream: false,
      input: [{ role: 'user', content: 'responses-style input' }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const before = JSON.parse(JSON.stringify(body.input));

    await handleChatCore(baseArgs({ body, rtkEnabled: true, sid: 'ffff6666' }));

    expect(body.input).toEqual(before);
  });

  it('isolates conversationState and survives a non-cloneable member', async () => {
    // Functions remain opaque handles, while their surrounding JSON containers
    // are private to the attempt.
    const body = {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      conversationState: { history: [], notCloneable() {} },
    };

    await expect(
      handleChatCore(baseArgs({ body, rtkEnabled: true, sid: 'aaaa7777' }))
    ).resolves.toBeTruthy();
    expect(mocks.executeMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a body with neither messages nor input alone', async () => {
    const body = {
      model: 'openai/gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      // Not an array: the isolation skips it rather than throwing.
      input: 'not-an-array',
    };
    await expect(
      handleChatCore(baseArgs({ body, rtkEnabled: true, sid: 'bbbb8888' }))
    ).resolves.toBeTruthy();
    expect(body.input).toBe('not-an-array');
  });
});
