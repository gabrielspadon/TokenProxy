// createResponsesApiTransformStream: Chat Completions SSE in, Responses API
// SSE out. Pins usage mapping (cost/usage tracking), reasoning handling in
// both native and <think>-tag form, tool_call buffering, and the flush path
// that must complete a stream even when the upstream never sent finish_reason.
import { describe, it, expect } from 'vitest';
import { createResponsesApiTransformStream } from 'open-sse/transformer/responsesTransformer.js';

const enc = new TextEncoder();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function drive(chunks) {
  const stream = createResponsesApiTransformStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const outParts = [];
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outParts.push(new TextDecoder().decode(value));
    }
  })();
  for (const c of chunks) {
    await writer.write(typeof c === 'string' ? enc.encode(c) : c);
  }
  await writer.close();
  await readAll;
  const raw = outParts.join('');
  const events = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame.trim()) continue;
    const ev = frame.match(/^event: (.+)$/m)?.[1] ?? null;
    const data = frame.match(/^data: (.+)$/m)?.[1];
    events.push({ event: ev, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) });
  }
  return { raw, events };
}

const delta = (d, extra = {}) => ({ id: 'abc', choices: [{ index: 0, delta: d, ...extra }] });

describe('lifecycle and text path', () => {
  it('emits created + in_progress once, deltas, and completes on flush without finish_reason', async () => {
    const { events } = await drive([sse(delta({ content: 'Hel' })), sse(delta({ content: 'lo' }))]);
    const types = events.map((e) => e.event);
    expect(types.filter((t) => t === 'response.created')).toHaveLength(1);
    expect(types.filter((t) => t === 'response.in_progress')).toHaveLength(1);
    const deltas = events.filter((e) => e.event === 'response.output_text.delta');
    expect(deltas.map((e) => e.data.delta)).toEqual(['Hel', 'lo']);
    const done = events.find((e) => e.event === 'response.output_text.done');
    expect(done.data.text).toBe('Hello');
    const itemDone = events.find((e) => e.event === 'response.output_item.done');
    expect(itemDone.data.item.content[0].text).toBe('Hello');
    expect(events.find((e) => e.event === 'response.completed')).toBeTruthy();
    expect(events.at(-1).data).toBe('[DONE]');
    // response id derives from the upstream chunk id
    expect(events[0].data.response.id).toBe('resp_abc');
  });

  it('sequence numbers increase monotonically across every event', async () => {
    const { events } = await drive([sse(delta({ content: 'x' }))]);
    const seqs = events.filter((e) => e.data !== '[DONE]').map((e) => e.data.sequence_number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('an SSE message split across network chunks is buffered, not dropped', async () => {
    const whole = sse(delta({ content: 'split' }));
    const { events } = await drive([whole.slice(0, 15), whole.slice(15)]);
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe('split');
  });

  it('a multi-byte UTF-8 character split across chunks survives intact', async () => {
    const bytes = enc.encode(sse(delta({ content: 'héllo' })));
    // cut inside the 2-byte é sequence
    const cut = [...bytes].findIndex((b) => b === 0xc3) + 1;
    const { events } = await drive([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe('héllo');
  });

  it('invalid data lines and [DONE] from upstream are skipped silently', async () => {
    const { events } = await drive([
      'data: {broken\n\n',
      ': comment\n\n',
      sse(delta({ content: 'ok' })),
      'data: [DONE]\n\n',
    ]);
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe('ok');
  });

  it('a final message left in the buffer without its terminator is still processed on flush', async () => {
    const frame = `data: ${JSON.stringify(delta({ content: 'tail' }))}`; // no \n\n
    const { events } = await drive([frame]);
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe('tail');
  });
});

describe('usage mapping (cost and context accounting)', () => {
  it('maps prompt/completion tokens with cached and reasoning details into response.completed', async () => {
    const { events } = await drive([
      sse(delta({ content: 'x' })),
      sse({
        id: 'abc',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 90 },
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      }),
    ]);
    const completed = events.find((e) => e.event === 'response.completed');
    expect(completed.data.response.usage).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      input_tokens_details: { cached_tokens: 90 },
      output_tokens_details: { reasoning_tokens: 15 },
    });
  });

  it('missing total_tokens is derived from the sum; absent details are omitted', async () => {
    const { events } = await drive([
      sse({ id: 'a', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      sse(delta({ content: 'x' })),
    ]);
    const usage = events.find((e) => e.event === 'response.completed').data.response.usage;
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('no usage from upstream → completed carries no usage key (nothing fabricated)', async () => {
    const { events } = await drive([sse(delta({ content: 'x' }))]);
    const completed = events.find((e) => e.event === 'response.completed');
    expect(completed.data.response).not.toHaveProperty('usage');
  });
});

describe('reasoning', () => {
  it('reasoning_content deltas open a reasoning item and close with the full text', async () => {
    const { events } = await drive([
      sse(delta({ reasoning_content: 'think ' })),
      sse(delta({ reasoning_content: 'hard' })),
      sse(delta({ content: 'answer' })),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    const added = events.find((e) => e.event === 'response.output_item.added');
    expect(added.data.item.type).toBe('reasoning');
    const rdone = events.find((e) => e.event === 'response.reasoning_summary_text.done');
    expect(rdone.data.text).toBe('think hard');
    const itemDones = events.filter((e) => e.event === 'response.output_item.done');
    expect(itemDones.at(-1).data.item.summary?.[0]?.text ?? itemDones.at(-1).data.item.content?.[0]?.text)
      .toBeDefined();
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe('answer');
  });

  it('<think> tags split reasoning from text even across separate deltas', async () => {
    const { events } = await drive([
      sse(delta({ content: '<think>reason' })),
      sse(delta({ content: 'ing</think>final' })),
      sse(delta({ content: ' text' })),
    ]);
    const rdone = events.find((e) => e.event === 'response.reasoning_summary_text.done');
    expect(rdone.data.text).toBe('reasoning');
    expect(events.find((e) => e.event === 'response.output_text.done').data.text).toBe(
      'final text'
    );
  });
});

describe('tool calls', () => {
  it('buffers streamed arguments per tool index and closes with the concatenated JSON', async () => {
    const { events } = await drive([
      sse(delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_w', arguments: '{"a"' } }] })),
      sse(delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] })),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const added = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call'
    );
    expect(added.data.item).toMatchObject({ call_id: 'call_1', name: 'get_w' });
    const argDeltas = events.filter((e) => e.event === 'response.function_call_arguments.delta');
    expect(argDeltas.map((e) => e.data.delta).join('')).toBe('{"a":1}');
    const argsDone = events.find((e) => e.event === 'response.function_call_arguments.done');
    expect(argsDone.data.arguments).toBe('{"a":1}');
    const itemDone = events.find(
      (e) => e.event === 'response.output_item.done' && e.data.item.type === 'function_call'
    );
    expect(itemDone.data.item).toMatchObject({ call_id: 'call_1', name: 'get_w', arguments: '{"a":1}' });
  });

  it('a text message followed by a tool_call closes the message before the call opens', async () => {
    const { events } = await drive([
      sse(delta({ content: 'let me check' })),
      sse(delta({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'f', arguments: '{}' } }] })),
    ]);
    const txtDoneIdx = events.findIndex((e) => e.event === 'response.output_text.done');
    const fcAddedIdx = events.findIndex(
      (e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call'
    );
    expect(txtDoneIdx).toBeGreaterThan(-1);
    expect(fcAddedIdx).toBeGreaterThan(txtDoneIdx);
  });

  it('a stream ending mid-tool-call still emits the done events on flush (no dangling call)', async () => {
    const { events } = await drive([
      sse(delta({ tool_calls: [{ index: 0, id: 'c3', function: { name: 'g', arguments: '{"x":' } }] })),
      sse(delta({ tool_calls: [{ index: 0, function: { arguments: '2}' } }] })),
      // upstream dies: no finish_reason, no [DONE]
    ]);
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    expect(done.data.arguments).toBe('{"x":2}');
    expect(events.find((e) => e.event === 'response.completed')).toBeTruthy();
  });
});
