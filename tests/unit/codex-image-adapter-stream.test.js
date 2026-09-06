/**
 * Codex image adapter contract tests: request shaping (headers/body), SSE
 * stream assembly (partial images, final b64, client piping), and error
 * propagation. No network: streams are built in-memory Responses.
 */

import { describe, it, expect, vi } from 'vitest';
import codex from '../../open-sse/handlers/imageProviders/codex.js';
import { PROVIDERS } from '../../open-sse/config/providers.js';

function sseResponse(blocks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(enc.encode(b));
      controller.close();
    },
  });
  return new Response(stream);
}

function sseBlock(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Minimal unsigned JWT whose payload carries the chatgpt account id claim
function fakeIdToken(payload) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

async function readSse(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1];
      const data = /data: (.+)/.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

describe('codex adapter request shaping', () => {
  it('buildUrl returns the configured provider base URL', () => {
    expect(codex.buildUrl()).toBe(PROVIDERS['codex'].baseUrl);
  });

  it('buildHeaders prefers providerSpecificData account id and bears the access token', () => {
    const h = codex.buildHeaders({
      accessToken: 'at-1',
      providerSpecificData: { chatgptAccountId: 'acct-direct' },
    });
    expect(h['authorization']).toBe('Bearer at-1');
    expect(h['chatgpt-account-id']).toBe('acct-direct');
    expect(h['accept']).toContain('text/event-stream');
    expect(h['session_id']).toBeTruthy();
    expect(h['x-client-request-id']).toBeTruthy();
  });

  it('buildHeaders decodes the account id from the idToken JWT payload', () => {
    const idToken = fakeIdToken({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-jwt' },
    });
    const h = codex.buildHeaders({ accessToken: 'at-2', idToken });
    expect(h['chatgpt-account-id']).toBe('acct-jwt');
  });

  it('buildHeaders degrades to empty strings on missing/garbage credentials', () => {
    expect(codex.buildHeaders({})['authorization']).toBe('Bearer ');
    expect(codex.buildHeaders({ idToken: 'not.a.jwt.at.all' })['chatgpt-account-id']).toBe('');
    expect(codex.buildHeaders({ idToken: 'x.y' })['chatgpt-account-id']).toBe('');
  });

  it('buildBody strips the image suffix, streams, and forwards optional tool params', () => {
    const body = codex.buildBody('gpt-5-image', {
      prompt: 'a lighthouse',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'WEBP',
    });
    expect(body.model).toBe('gpt-5');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    const tool = body.tools[0];
    expect(tool).toMatchObject({
      type: 'image_generation',
      output_format: 'webp',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
    });
    expect(body.input[0].content.at(-1)).toEqual({ type: 'input_text', text: 'a lighthouse' });
  });

  it('buildBody omits empty optional params and keeps unsuffixed model names', () => {
    const body = codex.buildBody('gpt-5', { prompt: 'p', size: '', quality: '' });
    expect(body.model).toBe('gpt-5');
    const tool = body.tools[0];
    expect(tool.size).toBeUndefined();
    expect(tool.quality).toBeUndefined();
    expect(tool.output_format).toBe('png');
  });

  it('buildBody wraps reference images as data URLs with framing text', () => {
    const rawB64 = Buffer.from('img').toString('base64');
    const body = codex.buildBody('m', {
      prompt: 'edit it',
      images: [rawB64, 'https://example.invalid/ref.png', null],
      image: 'data:image/png;base64,abc',
      image_detail: 'low',
    });
    const content = body.input[0].content;
    const imgs = content.filter((c) => c.type === 'input_image');
    expect(imgs.map((c) => c.image_url)).toEqual([
      `data:image/png;base64,${rawB64}`,
      'https://example.invalid/ref.png',
      'data:image/png;base64,abc',
    ]);
    expect(imgs.every((c) => c.detail === 'low')).toBe(true);
    expect(content[0].text).toContain('image1');
    expect(content.at(-1).text).toBe('edit it');
  });
});

describe('codex adapter SSE parsing (non-streaming)', () => {
  it('collects the final image b64 from response.output_item.done', async () => {
    const response = sseResponse([
      sseBlock('response.created', {}),
      sseBlock('response.output_item.done', {
        item: { type: 'image_generation_call', result: 'B64DATA' },
      }),
      sseBlock('response.completed', {}),
    ]);

    const parsed = await codex.parseResponse(response, { log: null, streamToClient: false });
    expect(parsed.data).toEqual([{ b64_json: 'B64DATA' }]);
    expect(typeof parsed.created).toBe('number');
    expect(codex.normalize(parsed)).toBe(parsed);
  });

  it('handles chunk boundaries splitting an SSE block and ignores malformed data', async () => {
    const whole =
      sseBlock('response.output_item.done', { item: { type: 'other' } }) +
      'event: response.output_item.done\ndata: {not json\n\n' +
      sseBlock('response.output_item.done', {
        item: { type: 'image_generation_call', result: 'SPLIT64' },
      });
    const mid = Math.floor(whole.length / 2);
    const response = sseResponse([whole.slice(0, mid), whole.slice(mid)]);

    const parsed = await codex.parseResponse(response, { log: null, streamToClient: false });
    expect(parsed.data[0].b64_json).toBe('SPLIT64');
  });

  it('throws when the stream ends without an image', async () => {
    const response = sseResponse([
      sseBlock('response.created', {}),
      sseBlock('response.completed', {}),
    ]);
    await expect(
      codex.parseResponse(response, { log: null, streamToClient: false })
    ).rejects.toThrow(/did not return an image/);
  });
});

describe('codex adapter SSE streaming to client', () => {
  it('pipes progress, partial images, and done to the client and fires onRequestSuccess', async () => {
    const upstream = sseResponse([
      sseBlock('response.created', {}),
      sseBlock('response.image_generation_call.partial_image', {
        partial_image_b64: 'PARTIAL',
        partial_image_index: 0,
      }),
      sseBlock('response.output_item.done', {
        item: { type: 'image_generation_call', result: 'FINAL64' },
      }),
    ]);
    const onRequestSuccess = vi.fn();
    const log = { info: vi.fn() };

    const { sseResponse: out } = await codex.parseResponse(upstream, {
      log,
      streamToClient: true,
      onRequestSuccess,
    });
    expect(out.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSse(out);
    expect(events.some((e) => e.event === 'progress')).toBe(true);
    const partial = events.find((e) => e.event === 'partial_image');
    expect(partial.data).toEqual({ b64_json: 'PARTIAL', index: 0 });
    const done = events.find((e) => e.event === 'done');
    expect(done.data.data).toEqual([{ b64_json: 'FINAL64' }]);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it('emits an error event when the stream carries no image, without onRequestSuccess', async () => {
    const upstream = sseResponse([sseBlock('response.created', {})]);
    const onRequestSuccess = vi.fn();

    const { sseResponse: out } = await codex.parseResponse(upstream, {
      log: null,
      streamToClient: true,
      onRequestSuccess,
    });
    const events = await readSse(out);
    const err = events.find((e) => e.event === 'error');
    expect(err.data.message).toMatch(/did not return an image/);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it('emits an error event when reading the upstream stream throws', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream reset'));
        },
      })
    );

    const { sseResponse: out } = await codex.parseResponse(broken, {
      log: null,
      streamToClient: true,
    });
    const events = await readSse(out);
    expect(events.find((e) => e.event === 'error').data.message).toBe('upstream reset');
  });
});
