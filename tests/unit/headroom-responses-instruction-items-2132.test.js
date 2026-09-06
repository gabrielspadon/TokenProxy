// #2132: "Token saver Headroom in version 0.5.12 makes Codex CLI never create
// plan in plan mode, in the version 0.5.8 still works fine."
//
// 0.5.12 is where #1998 added the openai-responses branch to compressWithHeadroom,
// so 0.5.8 "working" is 0.5.8 never running this code at all.
//
// The branch projects Responses input[] to Chat messages, compresses, and
// translates back. openaiToOpenAIResponsesRequest hoists the FIRST system or
// developer message into `instructions` and drops every later one, and the
// branch copies only the rebuilt `input` back — so a developer item in `input`
// was deleted from the request outright. Codex CLI carries its plan-mode
// directive as exactly that item, which is why the model stopped producing a
// plan while everything else still worked.
//
// The saver still runs; instruction items are simply kept local, the same rule
// the Claude branch already applies to `system`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressWithHeadroom as compressWithPolicy, resetHeadroomCircuitBreaker } from '../../open-sse/rtk/headroom.js';
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

afterEach(() => {
  vi.restoreAllMocks();
  resetHeadroomCircuitBreaker();
});

const URL_ = 'http://localhost:8787';
const PAD = ' padding'.repeat(200);
const PLAN_DIRECTIVE = `## Plan mode\nYou MUST call update_plan before acting.${PAD}`;

// Stand-in proxy compresses historical assistant text; instructions and current
// user requests stay exact even with lossy compression enabled.
function proxyCompressingEverything(transform = (m) => ({ ...m, content: 'C' })) {
  const fn = vi.fn(async (_url, init) => {
    fn.lastPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        messages: fn.lastPayload.messages.map((m) => m.role !== "assistant" ? m : transform(m)),
        tokens_before: 1000,
        tokens_after: 100,
        tokens_saved: 900,
      }),
      { status: 200 }
    );
  });
  return fn;
}

function message(role, text) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

function codexPlanModeBody() {
  return {
    model: 'gpt-5-codex',
    instructions: `You are Codex, based on GPT-5.${PAD}`,
    input: [message('developer', PLAN_DIRECTIVE), message('assistant', `historical answer${PAD}`), message('user', 'build the feature')],
    tools: [
      { type: 'function', name: 'update_plan', parameters: { type: 'object', properties: {} } },
    ],
  };
}

const options = { enabled: true, url: URL_, model: 'gpt-5-codex', format: 'openai-responses' };

describe('#2132 headroom must not drop Responses instruction items', () => {
  it('keeps developer and current user items while compressing historical output', async () => {
    global.fetch = proxyCompressingEverything();
    const body = codexPlanModeBody();

    const stats = await compressWithHeadroom(body, options);

    expect(stats?.tokens_saved).toBe(900);
    expect(body.input.map((i) => i.role)).toEqual(['developer', 'assistant', 'user']);
    // The plan-mode directive is byte-for-byte what the client sent.
    expect(body.input[0].content[0].text).toBe(PLAN_DIRECTIVE);
    // Compression still happened on the turn that is safe to compress.
    expect(body.input[1].content[0].text).toBe('C');
    expect(body.input[2].content[0].text).toBe('build the feature');
    // Top-level instructions were never in input and stay untouched.
    expect(body.instructions).toBe(`You are Codex, based on GPT-5.${PAD}`);
  });

  it('keeps every instruction item, not only the first, and at its own index', async () => {
    global.fetch = proxyCompressingEverything();
    const body = {
      model: 'gpt-5-codex',
      input: [
        message('developer', `first directive${PAD}`),
        message('user', `hello${PAD}`),
        message('system', `second directive${PAD}`),
        message('assistant', `hi${PAD}`),
        message('user', `now do it${PAD}`),
      ],
    };

    const stats = await compressWithHeadroom(body, options);

    expect(stats?.tokens_saved).toBe(900);
    expect(body.input.map((i) => i.role)).toEqual([
      'developer',
      'user',
      'system',
      'assistant',
      'user',
    ]);
    expect(body.input[0].content[0].text).toBe(`first directive${PAD}`);
    expect(body.input[2].content[0].text).toBe(`second directive${PAD}`);
    expect(body.input[1].content[0].text).toBe(`hello${PAD}`);
    expect(body.input[3].content[0].text).toBe('C');
    expect(body.input[4].content[0].text).toBe(`now do it${PAD}`);
  });

  it('leaves an instruction-free body compressing exactly as before', async () => {
    global.fetch = proxyCompressingEverything();
    const body = {
      model: 'gpt-5-codex',
      instructions: `base${PAD}`,
      input: [message('user', `q${PAD}`), message('assistant', `a${PAD}`)],
    };

    const stats = await compressWithHeadroom(body, options);

    expect(stats?.tokens_saved).toBe(900);
    expect(body.input.map((i) => i.role)).toEqual(['user', 'assistant']);
    expect(body.input.map((i) => i.content[0].text)).toEqual([`q${PAD}`, 'C']);
  });

  it('fails open when the round trip loses a non-instruction item', async () => {
    // A message whose content comes back empty is skipped by
    // openaiToOpenAIResponsesRequest, so the rebuilt input is one item short of
    // the original and the positions no longer line up.
    global.fetch = proxyCompressingEverything((m) =>
      m.role === 'assistant' ? { ...m, content: [] } : { ...m, content: 'C' }
    );
    const body = {
      model: 'gpt-5-codex',
      input: [
        message('developer', PLAN_DIRECTIVE),
        message('user', `q${PAD}`),
        message('assistant', `a${PAD}`),
      ],
    };
    const before = structuredClone(body.input);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, { ...options, diagnostics });

    expect(stats).toBeNull();
    expect(body.input).toEqual(before);
    expect(diagnostics.reason).toContain("protected content");
  });

  it('still refuses a body carrying non-message input items', async () => {
    global.fetch = proxyCompressingEverything();
    const body = {
      model: 'gpt-5-codex',
      input: [
        message('developer', PLAN_DIRECTIVE),
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      ],
    };
    const before = structuredClone(body.input);

    expect(await compressWithHeadroom(body, options)).toBeNull();
    expect(body.input).toEqual(before);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
