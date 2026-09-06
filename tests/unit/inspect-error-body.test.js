import { expect, it } from 'vitest';
import { inspectErrorBody } from '../../open-sse/utils/inspectErrorBody.js';
const encoded = text => new TextEncoder().encode(text);

it('reads exact complete Unicode bytes without consuming the original response', async () => {
  const text = '{"error":"日本語 denied"}', response = new Response(text, { status: 400 });
  expect(await inspectErrorBody(response)).toEqual({ complete: true, text });
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe(text);
});

it('refuses to classify an oversized or incomplete body and preserves original bytes', async () => {
  const text = 'The requested model is not supported' + 'x'.repeat(17000);
  const response = new Response(text, { status: 400 });
  expect(await inspectErrorBody(response)).toMatchObject({ complete: false, text: null, reason: 'byte-limit' });
  expect(await response.text()).toBe(text);
});

it('finishes bounded inspection without waiting for the unconsumed tee branch', async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(encoded('partial')); } }), { status: 400 });
  expect(await inspectErrorBody(response, { timeoutMs: 10 })).toMatchObject({ complete: false, reason: 'deadline' });
  controller.close();
  expect(await response.text()).toBe('partial');
});

it('propagates cancellation and removes its pending reader', async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }), { status: 400 });
  const abort = new AbortController(), reason = new Error('caller cancelled');
  const result = inspectErrorBody(response, { signal: abort.signal });
  abort.abort(reason);
  await expect(result).rejects.toBe(reason);
  controller.close();
  expect(await response.text()).toBe('');
});

it('does not treat invalid UTF-8 as complete evidence', async () => {
  const response = new Response(new Uint8Array([0xc0, 0xaf]), { status: 400 });
  expect(await inspectErrorBody(response)).toMatchObject({ complete: false, reason: 'unreadable' });
});
