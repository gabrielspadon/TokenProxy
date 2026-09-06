// Coverage for headroom.js branches: shape-guard rejections, endpoint
// building fallbacks, Kiro/Gemini projections and their guards, Claude
// pairing identity, Responses instruction restore mismatches, and the
// error/metric gates on callCompress responses. All network mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compressWithHeadroom,
  formatHeadroomLog,
  formatHeadroomSizeLog,
  isHeadroomPhantomSavings,
  resetHeadroomCircuitBreaker,
} from '../../open-sse/rtk/headroom.js';

const URL_OK = 'http://127.0.0.1:8787';

function mockCompress(payload, status = 200) {
  return vi
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(payload), { status }));
}

function bigText(n = 400) {
  return 'lorem ipsum dolor sit amet '.repeat(n);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetHeadroomCircuitBreaker();
  delete process.env.HEADROOM_API_KEY;
  delete process.env.HEADROOM_PROXY_TOKEN;
});

describe('entry gates', () => {
  it('skips when within context budget', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai',
        contextPressure: { over: false, projected: 10, budget: 100, limit: 200 },
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('within context budget');
  });

  it('skips on a missing body', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(null, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toBe('missing request body');
  });

  it('reports an unsupported shape for a body with no message container', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { foo: 1 },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('unsupported');
  });
});

describe('callCompress response gates', () => {
  const oaiBody = () => ({ messages: [{ role: 'user', content: bigText() }] });

  it('keeps the original on tokens_saved <= 0', async () => {
    mockCompress({ messages: [{ role: 'user', content: 'tiny' }], tokens_saved: 0 });
    const diagnostics = {};
    const res = await compressWithHeadroom(oaiBody(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('no token saving');
  });

  it('keeps the original on phantom token savings (>95%)', async () => {
    mockCompress({
      messages: [{ role: 'user', content: 'tiny' }],
      tokens_before: 1000,
      tokens_after: 990,
      tokens_saved: 10,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(oaiBody(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('phantom savings');
  });

  it('keeps the original on conflicting token metrics (string-encoded)', async () => {
    mockCompress({
      messages: [{ role: 'user', content: 'tiny' }],
      tokens_before: '-100',
      tokens_after: '-96',
      tokens_saved: '50',
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(oaiBody(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('conflicting token metrics');
  });

  it('passes a skip_reason without messages[] through as the diagnostic', async () => {
    mockCompress({ skip_reason: 'payload too small' });
    const diagnostics = {};
    const res = await compressWithHeadroom(oaiBody(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toBe('payload too small');
  });
});

describe('OpenAI shape guard', () => {
  const src = () => ({
    messages: [
      { role: 'user', content: bigText() },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: bigText() },
    ],
  });

  it('rejects a candidate that drops tool_calls pairing', async () => {
    mockCompress({
      messages: [
        { role: 'user', content: 'small' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_OTHER', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'small' },
      ],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(src(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('tool pairing identity');
  });

  it('rejects a candidate that rewrites tool_call_id', async () => {
    mockCompress({
      messages: [
        { role: 'user', content: 'small' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_9', content: 'small' },
      ],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(src(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('message count or order');
  });

  it('rejects a candidate whose null content has no tool_calls on either side', async () => {
    mockCompress({
      messages: [{ role: 'user', content: null }],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [{ role: 'user', content: bigText() }] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('message count or order');
  });

  it('keeps the original on phantom byte savings on the openai path', async () => {
    const body = { messages: [{ role: 'user', content: bigText() }] };
    mockCompress({
      messages: [{ role: 'user', content: bigText(399) }],
      tokens_before: 1000,
      tokens_after: 500,
      tokens_saved: 500,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('phantom savings');
    expect(body.messages[0].content).toBe(bigText()); // rolled back
  });

  it('reads commandcode messages one level down under params', async () => {
    const body = { params: { messages: [{ role: 'user', content: bigText() }] } };
    mockCompress({
      messages: [{ role: 'user', content: 'compressed short' }],
      tokens_before: 1000,
      tokens_after: 100,
      tokens_saved: 900,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'commandcode',
      diagnostics,
    });
    expect(res).not.toBeNull();
    expect(body.params.messages[0].content).toBe('compressed short');
  });
});

describe('Claude branch guards', () => {
  it('rejects a compressed set that loses tool pairing ids', async () => {
    const body = {
      messages: [
        { role: 'user', content: bigText() },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    };
    mockCompress({
      messages: [
        { role: 'user', content: 'small' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_XX', name: 'f', input: {} }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'claude',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('tool pairing identity');
  });

  it('rejects a compressed message whose content is neither string nor array', async () => {
    const body = { messages: [{ role: 'user', content: bigText() }] };
    mockCompress({ messages: [{ role: 'user', content: 42 }], tokens_saved: 100 });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'claude',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('Claude message shape');
  });

  it('reports an unsupported claude shape when messages is absent', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { input: [] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'claude',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toBe('unsupported claude request shape');
  });
});

describe('Kiro projection', () => {
  function kiroBody() {
    return {
      conversationState: {
        history: [
          {
            userInputMessage: {
              content: bigText(),
              systemInstruction: 'sys',
              userInputMessageContext: {
                toolResults: [{ toolUseId: 't1', content: [{ text: bigText() }] }],
              },
            },
          },
          {
            assistantResponseMessage: {
              content: bigText(),
              toolUses: [{ toolUseId: 't1', name: 'f', input: { a: 1 } }],
            },
          },
        ],
        currentMessage: { userInputMessage: { content: 'current question' } },
      },
    };
  }

  it('compresses and writes text back through the projection targets', async () => {
    const body = kiroBody();
    // Mirror the projected roles: system, user, tool, assistant, user.
    mockCompress({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u1' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u2' },
      ],
      tokens_before: 1000,
      tokens_after: 100,
      tokens_saved: 900,
    });
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'kiro',
      diagnostics: {},
    });
    expect(res).not.toBeNull();
    const history = body.conversationState.history;
    expect(history[0].userInputMessage.content).toBe('u1');
    expect(history[0].userInputMessage.systemInstruction).toBe('s');
    expect(history[0].userInputMessage.userInputMessageContext.toolResults[0].content[0].text).toBe(
      't'
    );
    expect(history[1].assistantResponseMessage.content).toBe('a');
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe('u2');
  });

  it('rejects a role-mismatched projection reply', async () => {
    const body = kiroBody();
    mockCompress({
      messages: [
        { role: 'user', content: 'wrong-first-role' },
        { role: 'user', content: 'u1' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u2' },
      ],
      tokens_saved: 900,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'kiro',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('Kiro message order');
  });

  it('rejects a reply message with no extractable text', async () => {
    const body = kiroBody();
    mockCompress({
      messages: [
        { role: 'system', content: [{ type: 'image' }] },
        { role: 'user', content: 'u1' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u2' },
      ],
      tokens_saved: 900,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'kiro',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('missing Kiro text content');
  });

  it('skips a Kiro body that projects to no messages', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { conversationState: { history: [] } },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'kiro',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('did not project');
  });

  it('keeps the original on phantom projected-size savings', async () => {
    const body = kiroBody();
    // Echo the projection back nearly unchanged.
    mockCompress({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: bigText() },
        { role: 'tool', content: bigText() },
        { role: 'assistant', content: bigText() },
        { role: 'user', content: 'current question' },
      ],
      tokens_saved: 900,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'kiro',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('phantom savings');
  });
});

describe('Gemini projection', () => {
  function geminiBody() {
    return {
      systemInstruction: { parts: [{ text: 'system text' }] },
      contents: [
        { role: 'user', parts: [{ text: bigText() }, { functionCall: { name: 'f', args: {} } }] },
        { role: 'model', parts: [{ text: bigText() }] },
      ],
    };
  }

  it('compresses and writes back only text parts', async () => {
    const body = geminiBody();
    mockCompress({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
      tokens_before: 1000,
      tokens_after: 100,
      tokens_saved: 900,
    });
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'gemini',
      diagnostics: {},
    });
    expect(res).not.toBeNull();
    expect(body.systemInstruction.parts[0].text).toBe('s');
    expect(body.contents[0].parts[0].text).toBe('u');
    expect(body.contents[0].parts[1].functionCall).toBeDefined(); // untouched
    expect(body.contents[1].parts[0].text).toBe('a');
  });

  it('reads the antigravity-nested request object', async () => {
    const body = { request: geminiBody() };
    mockCompress({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
      tokens_before: 1000,
      tokens_after: 100,
      tokens_saved: 900,
    });
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'antigravity',
      diagnostics: {},
    });
    expect(res).not.toBeNull();
    expect(body.request.contents[0].parts[0].text).toBe('u');
  });

  it('skips a gemini body with no text parts', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { contents: [{ role: 'user', parts: [{ inlineData: {} }] }] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'gemini',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('did not project');
  });

  it('keeps the original on phantom projected savings', async () => {
    const body = geminiBody();
    mockCompress({
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: bigText() },
        { role: 'assistant', content: bigText() },
      ],
      tokens_saved: 900,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(body, {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'gemini',
      diagnostics,
    });
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('phantom savings');
  });
});

describe('openai-responses branch', () => {
  it('skips when input carries a non-message item type', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      {
        input: [{ type: 'reasoning', summary: [] }],
      },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai-responses',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('not safe to compress');
  });

  it('skips when a message item would vanish in projection (empty content)', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      {
        input: [{ type: 'message', role: 'user', content: [] }],
      },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai-responses',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('empty content');
  });

  it('skips an untyped item with no role', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      {
        input: [{ foo: 'bar' }],
      },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai-responses',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('untyped responses item');
  });
});

describe('transport failures and circuit breaker cooldown', () => {
  it('opens the breaker after repeat failures and reports the cooldown', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );
    const body = () => ({ messages: [{ role: 'user', content: bigText() }] });
    const opts = (diagnostics) => ({
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics,
    });
    const d1 = {};
    const d2 = {};
    const d3 = {};
    await compressWithHeadroom(body(), opts(d1));
    await compressWithHeadroom(body(), opts(d2));
    const res = await compressWithHeadroom(body(), opts(d3));
    expect(res).toBeNull();
    expect(d1.reason).toContain('request failed');
    expect(d1.reason).toContain('ECONNREFUSED');
    expect(d3.reason).toContain('circuit breaker active');
  });

  it('reports a rejected config.mode on HTTP 400 and a plain status otherwise', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('bad', { status: 400 }))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const body = () => ({ messages: [{ role: 'user', content: bigText() }] });
    const d1 = {};
    await compressWithHeadroom(body(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics: d1,
    });
    expect(d1.reason).toContain('rejected config.mode');
    resetHeadroomCircuitBreaker();
    const d2 = {};
    await compressWithHeadroom(body(), {
      enabled: true,
      url: URL_OK,
      model: 'm',
      format: 'openai',
      diagnostics: d2,
    });
    expect(d2.reason).toContain('HTTP 500');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a response carrying CCR hashes', async () => {
    mockCompress({
      messages: [{ role: 'user', content: 'x' }],
      ccr_hashes: ['h1'],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [{ role: 'user', content: bigText() }] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('CCR markers');
  });

  it('rejects a response with a CCR marker inside a message', async () => {
    mockCompress({
      messages: [{ role: 'user', content: 'see <<ccr:abc123>>' }],
      tokens_saved: 100,
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [{ role: 'user', content: bigText() }] },
      {
        enabled: true,
        url: URL_OK,
        model: 'm',
        format: 'openai',
        diagnostics,
      }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('CCR markers');
  });

  it('survives an unparseable endpoint URL via the string fallback', async () => {
    const fetchSpy = mockCompress({
      messages: [{ role: 'user', content: 'x' }],
      compression_skipped: true,
    });
    const diagnostics = {};
    await compressWithHeadroom(
      { messages: [{ role: 'user', content: bigText() }] },
      {
        enabled: true,
        url: 'not a url?q=1#frag',
        model: 'm',
        format: 'openai',
        diagnostics,
      }
    );
    const endpoint = fetchSpy.mock.calls[0][0];
    expect(endpoint).toContain('/v1/compress');
    expect(endpoint).not.toContain('#');
    expect(diagnostics.endpoint).not.toContain('q=1');
  });
});

describe('formatters', () => {
  it('formatHeadroomLog renders the token delta line', () => {
    expect(formatHeadroomLog(null)).toBeNull();
    const line = formatHeadroomLog({ tokens_before: 200, tokens_after: 100, tokens_saved: 100 });
    expect(line).toContain('delta=100');
    expect(line).toContain('(50.0%)');
    expect(formatHeadroomLog({ tokens_saved: 5 })).toContain('(0%)');
  });

  it('formatHeadroomSizeLog needs both snapshots', () => {
    expect(formatHeadroomSizeLog({})).toBe('');
    const line = formatHeadroomSizeLog({
      before: { bodyBytes: 200, messageBytes: 150, toolSchemaBytes: 10, toolHistoryBytes: 5 },
      after: { bodyBytes: 100, messageBytes: 80, toolSchemaBytes: 10, toolHistoryBytes: 5 },
    });
    expect(line).toContain('body=200B');
    expect(line).toContain('effective=50.0%');
  });

  it('isHeadroomPhantomSavings flags claimed savings without byte shrink', () => {
    expect(isHeadroomPhantomSavings(null, {})).toBe(false);
    expect(isHeadroomPhantomSavings({ tokens_saved: 0 }, {})).toBe(false);
    const diag = { before: { bodyBytes: 100 }, after: { bodyBytes: 99 } };
    expect(isHeadroomPhantomSavings({ tokens_saved: 50 }, diag)).toBe(true);
    const shrunk = { before: { bodyBytes: 100 }, after: { bodyBytes: 50 } };
    expect(isHeadroomPhantomSavings({ tokens_saved: 50 }, shrunk)).toBe(false);
  });
});

describe('claude branch guards and entry fallbacks', () => {
  it('skips on a missing proxy URL', async () => {
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [{ role: 'user', content: 'x' }] },
      { enabled: true, url: '', model: 'm', format: 'claude', diagnostics }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toBe('missing proxy URL');
  });

  it('keeps the original when the claude compression saves no bytes', async () => {
    const text = bigText();
    mockCompress({
      messages: [{ role: 'user', content: text }],
      tokens_before: '1000',
      tokens_after: '500',
      tokens_saved: '500',
    });
    const diagnostics = {};
    const res = await compressWithHeadroom(
      { messages: [{ role: 'user', content: text }] },
      { enabled: true, url: URL_OK, model: 'm', format: 'claude', diagnostics }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('phantom savings');
  });

  it('skips when no oldest-first claude slice fits under the byte cap', async () => {
    const spy = mockCompress({ messages: [] });
    const diagnostics = {};
    const res = await compressWithHeadroom(
      {
        messages: [
          { role: 'user', content: 'x'.repeat(300000) },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
      { enabled: true, url: URL_OK, model: 'm', format: 'claude', diagnostics }
    );
    expect(res).toBeNull();
    expect(diagnostics.reason).toContain('no message slice fits');
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats an unserializable body as zero bytes instead of throwing', async () => {
    const text = bigText();
    mockCompress({
      messages: [{ role: 'user', content: text }],
      tokens_before: '1000',
      tokens_after: '500',
      tokens_saved: '500',
    });
    const diagnostics = {};
    // BigInt makes JSON.stringify throw; jsonBytes must catch and report 0.
    const res = await compressWithHeadroom(
      { big: 1n, messages: [{ role: 'user', content: text }] },
      { enabled: true, url: URL_OK, model: 'm', format: 'claude', diagnostics }
    );
    expect(res).toBeNull();
    expect(diagnostics.before.bodyBytes).toBe(0);
  });
});
