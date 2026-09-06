// Coverage for stream.js branches the soak never reached: passthrough Azure
// field stripping, empty tool_calls removal, reasoning normalization, dedup
// of duplicate finish chunks, cancel() estimation, ollama accumulation, gemini
// thought parts, and the tool-call output-length counter.
import { describe, expect, it, vi } from 'vitest';
import { FORMATS } from 'open-sse/translator/formats.js';
import {
  createPassthroughStreamWithLogger,
  createSSETransformStreamWithLogger,
} from 'open-sse/utils/stream.js';

const encoder = new TextEncoder();
const dataLine = (obj) => `data: ${JSON.stringify(obj)}\n`;

function pipeChunks(chunks, transform) {
  const src = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return src.pipeThrough(transform);
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parsedDataFrames(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

const openaiChunk = (delta, extra = {}) => ({
  id: 'chatcmpl-abc12345',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta, ...extra }],
});

describe('passthrough normalization', () => {
  it('strips Azure prompt_filter_results and content_filter_results', async () => {
    const chunk = {
      ...openaiChunk({ content: 'hi' }),
      prompt_filter_results: [{ prompt_index: 0 }],
    };
    chunk.choices[0].content_filter_results = { hate: { filtered: false } };
    const out = await readAll(
      pipeChunks([dataLine(chunk)], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    const frames = parsedDataFrames(out);
    expect(frames[0].prompt_filter_results).toBeUndefined();
    expect(frames[0].choices[0].content_filter_results).toBeUndefined();
    expect(frames[0].choices[0].delta.content).toBe('hi');
  });

  it('removes an empty tool_calls array from a streaming delta', async () => {
    const chunk = openaiChunk({ content: 'x', tool_calls: [] });
    const out = await readAll(
      pipeChunks([dataLine(chunk)], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    const frames = parsedDataFrames(out);
    expect(frames[0].choices[0].delta.tool_calls).toBeUndefined();
  });

  it('normalizes delta.reasoning to delta.reasoning_content', async () => {
    const chunk = openaiChunk({ reasoning: 'thinking hard' });
    const out = await readAll(
      pipeChunks([dataLine(chunk)], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    const frames = parsedDataFrames(out);
    expect(frames[0].choices[0].delta.reasoning_content).toBe('thinking hard');
    expect(frames[0].choices[0].delta.reasoning).toBeUndefined();
  });

  it('drops a duplicate finish chunk and a duplicate [DONE]', async () => {
    const finish = openaiChunk({}, { finish_reason: 'stop' });
    finish.usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    const out = await readAll(
      pipeChunks(
        [
          dataLine(openaiChunk({ content: 'a' })),
          dataLine(finish),
          dataLine(finish),
          'data: [DONE]\n',
          'data: [DONE]\n',
        ],
        createPassthroughStreamWithLogger('prov', null, 'm')
      )
    );
    const finishCount = parsedDataFrames(out).filter((f) => f.choices?.[0]?.finish_reason).length;
    expect(finishCount).toBe(1);
    const doneCount = out.split('\n').filter((l) => l.trim() === 'data: [DONE]').length;
    expect(doneCount).toBe(1);
  });

  it('re-uses provider usage on a finish chunk that already carries valid usage', async () => {
    const withUsage = openaiChunk({ content: 'a' });
    withUsage.usage = { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 };
    const finish = openaiChunk({}, { finish_reason: 'stop' });
    finish.usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 9 };
    let reported = null;
    const out = await readAll(
      pipeChunks(
        [dataLine(withUsage), dataLine(finish)],
        createPassthroughStreamWithLogger('prov', null, 'm', 'conn-x', null, (content, usage) => {
          reported = usage;
        })
      )
    );
    // mergeUsage takes Math.max per field: max(7,5)=7, max(1,2)=2, max(8,9)=9.
    const finishFrame = parsedDataFrames(out).find((f) => f.choices?.[0]?.finish_reason);
    expect(finishFrame.usage.prompt_tokens).toBe(7);
    expect(finishFrame.usage.completion_tokens).toBe(2);
    expect(reported?.prompt_tokens).toBe(7);
  });

  it('normalizes a data:-without-space line and passes non-data lines through', async () => {
    const payload = JSON.stringify(openaiChunk({ content: 'z' }));
    const out = await readAll(
      pipeChunks(
        [`data:${payload}\n`, ': keepalive comment\n'],
        createPassthroughStreamWithLogger('prov', null, 'm')
      )
    );
    expect(out).toContain(': keepalive comment');
    expect(parsedDataFrames(out)[0].choices[0].delta.content).toBe('z');
  });

  it('skips a non-JSON data line instead of forwarding garbage', async () => {
    const out = await readAll(
      pipeChunks(
        ['data: <html>rate limited</html>\n', dataLine(openaiChunk({ content: 'ok' }))],
        createPassthroughStreamWithLogger('prov', null, 'm')
      )
    );
    expect(out).not.toContain('<html>');
    expect(parsedDataFrames(out)[0].choices[0].delta.content).toBe('ok');
  });

  it('flushes a trailing malformed frame exactly as received', async () => {
    // Broken JSON with no trailing newline lands in the flush path.
    const out = await readAll(
      pipeChunks(['data: {"broken":'], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    expect(out).toContain('data: {"broken":');
  });

  it('cancel() estimates usage from accumulated content and reports aborted', async () => {
    const onComplete = vi.fn();
    const streamState = {};
    const transform = createPassthroughStreamWithLogger(
      'prov',
      null,
      'm',
      'conn-1',
      { messages: [{ role: 'user', content: 'q' }] },
      onComplete,
      null,
      streamState
    );
    const src = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(dataLine(openaiChunk({ content: 'partial answer' }))));
        // Never closes: simulates a client hangup mid-stream.
      },
    });
    const reader = src.pipeThrough(transform).getReader();
    await reader.read();
    await reader.cancel(new Error('client hung up'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onComplete).toHaveBeenCalledTimes(1);
    const [content, usage, , meta] = onComplete.mock.calls[0];
    expect(content.content).toBe('partial answer');
    expect(usage).toBeTruthy();
    expect(meta.aborted).toBe(true);
    expect(streamState.content).toBe('partial answer');
  });
});

describe('translate-mode accumulation branches', () => {
  it('accumulates ollama NDJSON message content and thinking', async () => {
    const onComplete = vi.fn();
    const chunks = [
      JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content: 'hello ', thinking: 'hmm' },
        done: false,
      }) + '\n',
      JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content: 'world' },
        done: true,
        done_reason: 'stop',
      }) + '\n',
    ];
    await readAll(
      pipeChunks(
        chunks,
        createSSETransformStreamWithLogger(
          FORMATS.OLLAMA,
          FORMATS.OLLAMA,
          'prov',
          null,
          null,
          'm',
          'conn-2',
          null,
          onComplete
        )
      )
    );
    const [content] = onComplete.mock.calls[0];
    expect(content.content).toBe('hello world');
    expect(content.thinking).toBe('hmm');
  });

  it('splits gemini parts into content and thinking on part.thought', async () => {
    const onComplete = vi.fn();
    const chunk = dataLine({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'reasoning...', thought: true },
              { text: 'the answer' },
              { functionCall: { name: 'toolA', args: { q: 1 } } },
            ],
          },
        },
      ],
    });
    await readAll(
      pipeChunks(
        [chunk],
        createSSETransformStreamWithLogger(
          FORMATS.GEMINI,
          FORMATS.GEMINI,
          'prov',
          null,
          null,
          'm',
          'conn-3',
          null,
          onComplete
        )
      )
    );
    const [content, usage] = onComplete.mock.calls[0];
    expect(content.content).toBe('the answer');
    expect(content.thinking).toBe('reasoning...');
    // Tool-call output counted into estimation length: usage estimated > 0.
    expect(usage).toBeTruthy();
  });

  it('accumulates openai delta.reasoning when reasoning_content is absent', async () => {
    const onComplete = vi.fn();
    await readAll(
      pipeChunks(
        [
          dataLine(openaiChunk({ reasoning: 'raw-reasoning' })),
          dataLine(openaiChunk({ reasoning_content: 'rc' })),
          dataLine(openaiChunk({}, { finish_reason: 'stop' })),
          'data: [DONE]\n',
        ],
        createSSETransformStreamWithLogger(
          FORMATS.OPENAI,
          FORMATS.OPENAI,
          'prov',
          null,
          null,
          'm',
          'conn-4',
          null,
          onComplete
        )
      )
    );
    const [content] = onComplete.mock.calls[0];
    expect(content.thinking).toBe('raw-reasoningrc');
  });

  it('counts claude tool_use name and input_json fragments toward output length', async () => {
    const onComplete = vi.fn();
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await readAll(
      pipeChunks(
        [
          ev('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_01',
              role: 'assistant',
              model: 'm',
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
          ev('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_01', name: 'lookup' },
          }),
          ev('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"key":"value"}' },
          }),
          ev('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: {},
          }),
          ev('message_stop', { type: 'message_stop' }),
        ],
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.CLAUDE,
          'prov',
          null,
          null,
          'm',
          'conn-5',
          { messages: [{ role: 'user', content: 'q' }] },
          onComplete
        )
      )
    );
    const [, usage] = onComplete.mock.calls[0];
    // A tool-only turn still estimates non-zero output (#1382 branch).
    expect(usage?.output_tokens ?? usage?.completion_tokens ?? 0).toBeGreaterThan(0);
  });

  it('logs the OpenAI intermediate for a cross-format pivot stream', async () => {
    const openaiChunks = [];
    const reqLogger = {
      appendProviderChunk: () => {},
      appendConvertedChunk: () => {},
      appendOpenAIChunk: (c) => openaiChunks.push(c),
    };
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    // claude target -> gemini source pivots through openai.
    await readAll(
      pipeChunks(
        [
          ev('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_02',
              role: 'assistant',
              model: 'm',
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
          ev('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
          ev('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hi' },
          }),
          ev('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          }),
          ev('message_stop', { type: 'message_stop' }),
        ],
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.GEMINI,
          'prov',
          reqLogger,
          null,
          'm',
          'conn-6'
        )
      )
    );
    expect(openaiChunks.length).toBeGreaterThan(0);
  });
});

describe('remaining edge branches', () => {
  it('counts ollama message.tool_calls toward output length', async () => {
    const onComplete = vi.fn();
    const chunks = [
      JSON.stringify({
        model: 'm',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'toolB', arguments: { a: 1 } } }],
        },
        done: false,
      }) + '\n',
      JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n',
    ];
    await readAll(
      pipeChunks(
        chunks,
        createSSETransformStreamWithLogger(
          FORMATS.OLLAMA,
          FORMATS.OLLAMA,
          'prov',
          null,
          null,
          'm',
          'conn-7',
          { messages: [{ role: 'user', content: 'q' }] },
          onComplete
        )
      )
    );
    const [, usage] = onComplete.mock.calls[0];
    // Tool-call name+args counted, so estimation is non-zero despite empty content.
    expect(usage).toBeTruthy();
  });

  it('accumulates claude thinking deltas in translate mode', async () => {
    const onComplete = vi.fn();
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await readAll(
      pipeChunks(
        [
          ev('message_start', {
            type: 'message_start',
            message: { id: 'msg_03', role: 'assistant', model: 'm', usage: { input_tokens: 1, output_tokens: 0 } },
          }),
          ev('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          }),
          ev('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'pondering' },
          }),
          ev('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 3 },
          }),
          ev('message_stop', { type: 'message_stop' }),
        ],
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.CLAUDE,
          'prov',
          null,
          null,
          'm',
          'conn-8',
          null,
          onComplete
        )
      )
    );
    const [content] = onComplete.mock.calls[0];
    expect(content.thinking).toBe('pondering');
  });

  it('skips a passthrough chunk with no valuable content', async () => {
    const out = await readAll(
      pipeChunks(
        [dataLine(openaiChunk({})), dataLine(openaiChunk({ content: 'kept' }))],
        createPassthroughStreamWithLogger('prov', null, 'm')
      )
    );
    const frames = parsedDataFrames(out);
    expect(frames).toHaveLength(1);
    expect(frames[0].choices[0].delta.content).toBe('kept');
  });

  it('drops a trailing data: null frame and normalizes a trailing no-space frame', async () => {
    const outNull = await readAll(
      pipeChunks(['data: null'], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    expect(outNull).not.toContain('data: null');

    const payload = JSON.stringify(openaiChunk({ content: 'tail' }));
    const outTail = await readAll(
      pipeChunks([`data:${payload}`], createPassthroughStreamWithLogger('prov', null, 'm'))
    );
    expect(outTail).toContain(`data: ${payload}`);
  });

  it('translates a tail chunk left in the buffer at flush time', async () => {
    const openaiChunks = [];
    const reqLogger = {
      appendProviderChunk: () => {},
      appendConvertedChunk: () => {},
      appendOpenAIChunk: (c) => openaiChunks.push(c),
    };
    // Provider (claude) chunk with no trailing newline: flush parses and
    // translates it, and the cross-format pivot logs the OpenAI intermediate.
    const tail = 'data: ' + JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'late' },
    });
    const head = 'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_04', role: 'assistant', model: 'm', usage: { input_tokens: 1, output_tokens: 0 } },
    }) + '\n\nevent: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) + '\n\n';
    await readAll(
      pipeChunks(
        [head, tail],
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.GEMINI,
          'prov',
          reqLogger,
          null,
          'm',
          'conn-9'
        )
      )
    );
    const loggedBeforeFlush = openaiChunks.length;
    // The tail delta had no newline, so only flush could have logged it.
    expect(openaiChunks.some((c) => c.includes('late'))).toBe(true);
    expect(loggedBeforeFlush).toBeGreaterThan(0);
  });
});
