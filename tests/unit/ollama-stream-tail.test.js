// Regression: createSSEStream splits on "\n" and keeps the remainder, which
// only the flush parses. That flush called parseSSELine() without targetFormat,
// so it required a "data: " prefix and silently dropped whatever an NDJSON
// provider (Ollama) left without a closing newline. The bare `!parsed.done`
// guard compounded it: the SSE sentinel and an Ollama final chunk both carry
// done:true, but the latter is the real last chunk, holding done_reason and the
// token counts.
import { describe, expect, it } from 'vitest';

import { FORMATS } from 'open-sse/translator/formats.js';
import { createSSETransformStreamWithLogger } from 'open-sse/utils/stream.js';

const encoder = new TextEncoder();

async function drain(input, targetFormat, provider, model) {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of Array.isArray(input) ? input : [input]) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  const reader = stream
    .pipeThrough(
      createSSETransformStreamWithLogger(targetFormat, FORMATS.OPENAI, provider, null, null, model)
    )
    .getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const runOllama = (input) => drain(input, FORMATS.OLLAMA, 'ollama', 'gpt-oss:120b');

const deltas = (sse) =>
  sse
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)));

// Ollama speaks NDJSON: one raw JSON object per line, no "data: " prefix.
const chunk = (content, done = false) =>
  JSON.stringify({
    model: 'gpt-oss:120b',
    created_at: '2026-08-25T00:00:00Z',
    message: { role: 'assistant', content },
    done,
    ...(done ? { done_reason: 'stop', prompt_eval_count: 11, eval_count: 7 } : {}),
  });

describe('Ollama NDJSON stream: the tail left in the line buffer', () => {
  it('delivers a content chunk that arrived without its newline', async () => {
    const out = await runOllama([chunk('hello'), chunk(' world')].join('\n'));
    const content = deltas(out)
      .map((c) => c.choices?.[0]?.delta?.content || '')
      .join('');
    expect(content).toBe('hello world');
  });

  it('delivers the final chunk — finish_reason and usage — when it arrives without its newline', async () => {
    const out = await runOllama([chunk('hello'), chunk('', true)].join('\n'));
    const last = deltas(out).at(-1);
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it('is unchanged when every line is newline-terminated', async () => {
    const out = await runOllama(
      `${[chunk('hello'), chunk(' world'), chunk('', true)].join('\n')}\n`
    );
    const parsed = deltas(out);
    expect(parsed.map((c) => c.choices?.[0]?.delta?.content || '').join('')).toBe('hello world');
    expect(parsed.at(-1).choices[0].finish_reason).toBe('stop');
    expect(parsed.at(-1).usage.total_tokens).toBe(18);
  });

  it('rejects a malformed record instead of silently completing the stream', async () => {
    await expect(runOllama('{not-json}\n')).rejects.toThrow('Invalid Ollama NDJSON record');
  });

  it('rejects a record over 1 MiB before retaining another transport chunk', async () => {
    const oversized = JSON.stringify({
      message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) },
      done: false,
    });
    const midpoint = Math.floor(oversized.length / 2);
    await expect(runOllama([
      oversized.slice(0, midpoint),
      oversized.slice(midpoint),
    ])).rejects.toThrow('Ollama NDJSON record exceeded 1 MiB');
  });
});

describe('SSE providers keep their sentinel handling', () => {
  it('does not translate a trailing data: [DONE]', async () => {
    const body = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
    const out = await drain(`data: ${body}\ndata: [DONE]`, FORMATS.OPENAI, 'openai', 'gpt-4o');
    expect(out).toContain('"content":"hi"');
    // The sentinel is a framing marker, not a chunk — it must not be translated.
    expect(out).not.toContain('"done":true');
  });
});
