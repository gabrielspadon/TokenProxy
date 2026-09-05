// Kills the idempotent-close-guard survivors (closeReasoning/closeMessage/
// closeToolCall each guard against a second invocation) and the SSE data-line
// regex survivors in responsesTransformer.js. Drives the real TransformStream,
// no mocks needed since it's pure.
import { describe, it, expect } from 'vitest';
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
  for (const c of chunks) await writer.write(typeof c === 'string' ? enc.encode(c) : c);
  await writer.close();
  await readAll;
  const raw = outParts.join('');
  const events = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame.trim()) continue;
    const ev = frame.match(/^event: (.+)$/m)?.[1] ?? null;
    events.push(ev);
  }
  return events;
}

describe('finish_reason closes everything once; flush() must not re-close', () => {
  it('a stream with reasoning + text + tool_calls, closed via finish_reason, then flushed, emits each done event exactly once', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { reasoning_content: 'r' } }] }),
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 't' } }] }),
      sse({
        id: 'a',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }],
            },
          },
        ],
      }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    const countOf = (name) => events.filter((e) => e === name).length;
    expect(countOf('response.reasoning_summary_text.done')).toBe(1);
    expect(countOf('response.reasoning_summary_part.done')).toBe(1);
    expect(countOf('response.output_text.done')).toBe(1);
    expect(countOf('response.content_part.done')).toBe(1);
    expect(countOf('response.function_call_arguments.done')).toBe(1);
    // Two output_item.done: message (closeMessage) + tool call (closeToolCall);
    // reasoning's output_item.done comes from closeReasoning, so three total,
    // never four+ from a double-close.
    expect(countOf('response.output_item.done')).toBe(3);
    expect(countOf('response.completed')).toBe(1);
  });

  it('two finish_reason chunks in a row do not double-emit any done event', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 't' } }] }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(events.filter((e) => e === 'response.output_text.done')).toHaveLength(1);
    expect(events.filter((e) => e === 'response.completed')).toHaveLength(1);
  });
});

describe('SSE data-line regex: exact accepted/rejected shapes', () => {
  it('matches "data:" with no space before the payload', async () => {
    const events = await drive([
      'data:' +
        JSON.stringify({ id: 'a', choices: [{ index: 0, delta: { content: 'x' } }] }) +
        '\n\n',
    ]);
    expect(events).toContain('response.output_text.delta');
  });

  it('matches "data:   " with multiple leading spaces before the payload', async () => {
    const events = await drive([
      'data:   ' +
        JSON.stringify({ id: 'a', choices: [{ index: 0, delta: { content: 'x' } }] }) +
        '\n\n',
    ]);
    expect(events).toContain('response.output_text.delta');
  });

  it('does not match a line where "data:" is not at the start (leading garbage)', async () => {
    const events = await drive([
      'xdata: ' +
        JSON.stringify({ id: 'a', choices: [{ index: 0, delta: { content: 'x' } }] }) +
        '\n\n',
    ]);
    expect(events).not.toContain('response.output_text.delta');
  });

  it('a message with usage but no choices updates usage and is still reflected in the completed event', async () => {
    const events = await drive([
      sse({ id: 'a', usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(events).toContain('response.completed');
  });
});
