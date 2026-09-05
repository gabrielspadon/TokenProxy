// Deep-equality coverage for createResponsesApiTransformStream's emitted event
// payloads. The existing suites assert individual fields; this one drives one
// rich scenario through reasoning, text, and tool_call paths together and
// asserts every event's full shape, which is what actually kills the many
// StringLiteral/ObjectLiteral/ArrayDeclaration/BooleanLiteral mutants sitting
// in fields no single-field assertion touches (type tags, empty [] defaults,
// role, output_index bookkeeping that interleaves reasoning/message/tool
// output indices).
import { describe, it, expect, vi } from 'vitest';
import { createResponsesApiTransformStream } from 'open-sse/transformer/responsesTransformer.js';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function drive(chunks) {
  const enc = new TextEncoder();
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
  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await readAll;
  const raw = outParts.join('');
  const events = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame.trim()) continue;
    const ev = frame.match(/^event: (.+)$/m)?.[1] ?? null;
    const data = frame.match(/^data: (.+)$/m)?.[1];
    const parsed = data === '[DONE]' ? '[DONE]' : JSON.parse(data);
    if (parsed !== '[DONE]') delete parsed.sequence_number;
    events.push({ event: ev, data: parsed });
  }
  return events;
}

describe('full lifecycle: reasoning, then message, then tool call, then finish', () => {
  it('emits the exact payload shape at every step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));

    const events = await drive([
      sse({ id: 'X', choices: [{ index: 0, delta: { reasoning_content: 'foo' } }] }),
      sse({ id: 'X', choices: [{ index: 0, delta: { content: 'bar' } }] }),
      sse({
        id: 'X',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
      sse({ id: 'X', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    vi.useRealTimers();

    const created_at = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
    const byEvent = (name) => events.filter((e) => e.event === name);

    expect(byEvent('response.created')[0].data).toEqual({
      type: 'response.created',
      response: {
        id: 'resp_X',
        object: 'response',
        created_at,
        status: 'in_progress',
        background: false,
        error: null,
        output: [],
      },
    });

    expect(byEvent('response.in_progress')[0].data).toEqual({
      type: 'response.in_progress',
      response: { id: 'resp_X', object: 'response', created_at, status: 'in_progress' },
    });

    // Reasoning opened first: consumes output_index 0.
    const reasoningId = 'rs_resp_X_0';
    expect(byEvent('response.output_item.added')[0].data).toEqual({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: reasoningId, type: 'reasoning', summary: [] },
    });
    expect(byEvent('response.reasoning_summary_part.added')[0].data).toEqual({
      type: 'response.reasoning_summary_part.added',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    expect(byEvent('response.reasoning_summary_text.delta')[0].data).toEqual({
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: 'foo',
    });

    // Message opens second: consumes output_index 1 (proves ?? not && against
    // a falsy-but-present 0, and proves indices interleave with reasoning).
    const msgId = 'msg_resp_X_0';
    expect(byEvent('response.output_item.added')[1].data).toEqual({
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: msgId, type: 'message', content: [], role: 'assistant' },
    });
    expect(byEvent('response.content_part.added')[0].data).toEqual({
      type: 'response.content_part.added',
      item_id: msgId,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
    });
    expect(byEvent('response.output_text.delta')[0].data).toEqual({
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: 1,
      content_index: 0,
      delta: 'bar',
      logprobs: [],
    });

    // tool_calls delta closes the message (output_index 1) before opening the
    // function_call item at output_index 2.
    expect(byEvent('response.output_text.done')[0].data).toEqual({
      type: 'response.output_text.done',
      item_id: msgId,
      output_index: 1,
      content_index: 0,
      text: 'bar',
      logprobs: [],
    });
    expect(byEvent('response.content_part.done')[0].data).toEqual({
      type: 'response.content_part.done',
      item_id: msgId,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', annotations: [], logprobs: [], text: 'bar' },
    });
    expect(byEvent('response.output_item.done')[0].data).toEqual({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        id: msgId,
        type: 'message',
        content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'bar' }],
        role: 'assistant',
      },
    });

    expect(byEvent('response.output_item.added')[2].data).toEqual({
      type: 'response.output_item.added',
      output_index: 2,
      item: { id: 'fc_c1', type: 'function_call', arguments: '', call_id: 'c1', name: 'f' },
    });
    expect(byEvent('response.function_call_arguments.delta')[0].data).toEqual({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_c1',
      output_index: 2,
      delta: '{"a":1}',
    });

    // finish_reason closes reasoning, then the tool call.
    expect(byEvent('response.reasoning_summary_text.done')[0].data).toEqual({
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      text: 'foo',
    });
    expect(byEvent('response.reasoning_summary_part.done')[0].data).toEqual({
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: 'foo' },
    });
    expect(byEvent('response.output_item.done')[1].data).toEqual({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: reasoningId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'foo' }],
      },
    });

    expect(byEvent('response.function_call_arguments.done')[0].data).toEqual({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_c1',
      output_index: 2,
      arguments: '{"a":1}',
    });
    expect(byEvent('response.output_item.done')[2].data).toEqual({
      type: 'response.output_item.done',
      output_index: 2,
      item: { id: 'fc_c1', type: 'function_call', arguments: '{"a":1}', call_id: 'c1', name: 'f' },
    });

    expect(byEvent('response.completed')[0].data).toEqual({
      type: 'response.completed',
      response: {
        id: 'resp_X',
        object: 'response',
        created_at,
        status: 'completed',
        background: false,
        error: null,
      },
    });

    expect(events.at(-1)).toEqual({ event: null, data: '[DONE]' });
  });
});

describe('regex and control-flow edge cases not covered by the shape assertions above', () => {
  it('a data: line with no trailing content after the colon is skipped, not treated as empty payload', async () => {
    const events = await drive([
      'data:\n\n',
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 'ok' } }] }),
    ]);
    expect(events.some((e) => e.event === 'response.output_text.delta')).toBe(true);
  });

  it('a message with only whitespace between blank lines produces no events', async () => {
    const events = await drive([
      '   \n\n',
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 'ok' } }] }),
    ]);
    const textEvents = events.filter((e) => e.event === 'response.output_text.delta');
    expect(textEvents).toHaveLength(1);
  });

  it('choice.index defaults to 0, not left undefined, when the upstream omits it', async () => {
    const events = await drive([sse({ id: 'a', choices: [{ delta: { content: 'x' } }] })]);
    const added = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item.type === 'message'
    );
    expect(added.data.item.id).toBe('msg_resp_a_0');
  });

  it('a tool_calls entry index defaults to 0 when omitted', async () => {
    const events = await drive([
      sse({
        id: 'a',
        choices: [{ index: 0, delta: { tool_calls: [{ id: 'c9', function: { name: 'g' } }] } }],
      }),
    ]);
    const added = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call'
    );
    expect(added.data.output_index).toBe(0);
  });

  it('a chunk with an empty choices array carries no length and is skipped without throwing', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 'ok' } }] }),
    ]);
    expect(events.some((e) => e.event === 'response.output_text.delta')).toBe(true);
  });
});
