// Kills tool_calls index/id bookkeeping survivors and the sequence_number
// increment mutant in responsesTransformer.js.
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
    events.push({ event: ev, data: parsed });
  }
  return events;
}

describe('sequence_number strictly increments by 1, starting at 1', () => {
  it('every emitted event carries a monotonically increasing sequence_number', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { content: 'hi' } }] }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    const nums = events.filter((e) => e.data !== '[DONE]').map((e) => e.data.sequence_number);
    expect(nums[0]).toBe(1);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1);
  });
});

describe('tool_calls.index uses ?? 0, not && 0 (an explicit index:0 must not be dropped)', () => {
  it('a tool_calls entry with index explicitly 0 opens output_index 0, not undefined', async () => {
    const events = await drive([
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } },
        ],
      }),
    ]);
    const added = events.find((e) => e.event === 'response.output_item.added');
    expect(added.data.output_index).toBe(0);
  });
});

describe('a repeated tool_calls delta for the same index does not re-open the item or double the output index', () => {
  it('two chunks for tcIdx 0, first with id, second with only arguments, share one output_item.added', async () => {
    const events = await drive([
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } },
        ],
      }),
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } },
        ],
      }),
      sse({ id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    expect(
      events.filter(
        (e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call'
      )
    ).toHaveLength(1);
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    expect(done.data.arguments).toBe('{"a":1}');
  });
});

describe('nextOutputIndex only ever increases (no decrement on any path)', () => {
  it('reasoning then a tool call get strictly increasing, never-reused output indices', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { reasoning_content: 'r' } }] }),
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } },
        ],
      }),
    ]);
    const indices = events
      .filter((e) => e.event === 'response.output_item.added')
      .map((e) => e.data.output_index);
    expect(indices).toEqual([0, 1]);
  });
});

describe('tool_calls arguments delta guarded by tc.function?.arguments truthiness', () => {
  it('a tool_calls chunk with no function.arguments emits no arguments.delta event', async () => {
    const events = await drive([
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } },
        ],
      }),
    ]);
    expect(events.some((e) => e.event === 'response.function_call_arguments.delta')).toBe(false);
  });
});
