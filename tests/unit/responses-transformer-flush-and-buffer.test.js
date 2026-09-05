// Kills survivors around transform()'s buffer/message-split guards and
// flush()'s leftover-buffer replay and reasoning auto-close, none of which
// are exercised by the payload-shape suite (which always closes explicitly
// via finish_reason).
import { describe, it, expect, vi } from 'vitest';
import { createResponsesApiTransformStream } from 'open-sse/transformer/responsesTransformer.js';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function driveRaw(chunks) {
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
  return outParts.join('');
}

function parseEvents(raw) {
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

it('a message left in the buffer with no trailing blank-line terminator is still emitted at flush', async () => {
  // No trailing "\n\n" on the last chunk, so it sits in state.buffer until flush.
  const raw = await driveRaw([
    sse({ id: 'X', choices: [{ index: 0, delta: { content: 'hi' } }] }).slice(0, -2),
  ]);
  const events = parseEvents(raw);
  const delta = events.find((e) => e.event === 'response.output_text.delta');
  expect(delta.data.delta).toBe('hi');
});

it('reasoning left open with no finish_reason is still closed at flush', async () => {
  const raw = await driveRaw([
    sse({ id: 'X', choices: [{ index: 0, delta: { reasoning_content: 'r' } }] }),
  ]);
  const events = parseEvents(raw);
  expect(events.some((e) => e.event === 'response.reasoning_summary_text.done')).toBe(true);
  expect(events.some((e) => e.event === 'response.reasoning_summary_part.done')).toBe(true);
});

it('an all-blank buffer at flush time does not replay a bogus empty message', async () => {
  // Trailing chunk ends exactly on a "\n\n" boundary, so state.buffer is "" at flush.
  const raw = await driveRaw([sse({ id: 'X', choices: [{ index: 0, delta: { content: 'hi' } }] })]);
  const events = parseEvents(raw);
  // exactly one output_text.delta, not duplicated by a spurious flush replay
  expect(events.filter((e) => e.event === 'response.output_text.delta')).toHaveLength(1);
});

it('a "[DONE]" data line inside the stream is skipped, not parsed as JSON', async () => {
  const raw = await driveRaw(['data: [DONE]\n\n']);
  const events = parseEvents(raw);
  // only the terminal completed/[DONE] pair from flush, no crash, no extra events
  expect(events.some((e) => e.event === 'response.completed')).toBe(true);
});

it('a whitespace-only message segment between two real ones is skipped without emitting anything for it', async () => {
  const raw = await driveRaw([
    sse({ id: 'X', choices: [{ index: 0, delta: { content: 'a' } }] }) +
      '   \n\n' +
      sse({ id: 'X', choices: [{ index: 0, delta: { content: 'b' } }] }),
  ]);
  const events = parseEvents(raw);
  const deltas = events
    .filter((e) => e.event === 'response.output_text.delta')
    .map((e) => e.data.delta);
  expect(deltas).toEqual(['a', 'b']);
});

it('logger.logInput receives the trimmed raw chunk text when a logger is supplied', async () => {
  const logInput = vi.fn();
  const logger = { logInput, logOutput: vi.fn(), flush: vi.fn() };
  const enc = new TextEncoder();
  const stream = createResponsesApiTransformStream(logger);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const drain = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  const chunk = sse({ id: 'X', choices: [{ index: 0, delta: { content: 'hi' } }] });
  await writer.write(enc.encode(chunk));
  await writer.close();
  await drain;
  expect(logInput).toHaveBeenCalledWith(chunk.trim());
});
