// Kills remaining responsesTransformer.js survivors: closeReasoning firing
// even when the closing </think> leaves an empty thinkPart, the initial
// function_call name fallback to "" at open time, and the arguments.delta
// guard when no call id has ever been seen for that tool index.
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

describe('closeReasoning fires even when the closing tag leaves an empty thinkPart', () => {
  it('"<think></think>x" still emits reasoning_summary_text.done', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { content: '<think></think>x' } }] }),
    ]);
    expect(events.some((e) => e.event === 'response.reasoning_summary_text.done')).toBe(true);
  });
});

describe('function_call open-time name fallback', () => {
  it('a tool_calls entry with no function.name opens with name ""', async () => {
    const events = await drive([
      sse({ id: 'a', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1' }] } }] }),
    ]);
    const added = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call'
    );
    expect(added.data.item.name).toBe('');
  });
});

describe('arguments.delta guard: no id ever seen for the index', () => {
  it('an arguments-only chunk with no prior id and no id on this chunk emits no arguments.delta', async () => {
    const events = await drive([
      sse({
        id: 'a',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
        ],
      }),
    ]);
    expect(events.some((e) => e.event === 'response.function_call_arguments.delta')).toBe(false);
  });
});
