import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS, initialDraft, operationById, prepareRequest, sendGateway, diagnosticExport, MAX_RESPONSE_BYTES } from '../../src/shared/components/request-workbench/contracts';

function fixture(id, fields = {}) {
  const operation = operationById(id);
  const draft = { ...initialDraft(operation), model: 'gemini/synthetic', provider: 'edge-tts', jobId: 'synthetic-job', ...fields };
  const body = { ...operation.template, ...(operation.method || id === 'gemini' ? {} : { model: id.startsWith('video-') ? 'xai/synthetic-video' : 'synthetic/model' }) };
  if ('messages' in body) body.messages = [{ role: 'user', content: 'Synthetic test message' }];
  if ('contents' in body) body.contents = [{ role: 'user', parts: [{ text: 'Synthetic test message' }] }];
  for (const key of ['input', 'prompt', 'query']) if (key in body) body[key] = 'Synthetic fixture';
  if ('documents' in body) body.documents = ['Synthetic document'];
  if ('url' in body) body.url = 'https://example.invalid/fixture';
  if (id === 'image-edit') body.image = 'data:image/png;base64,iVBORw0KGgo=';
  if (id === 'ocr') body.document = { type: 'document_url', document_url: 'https://example.invalid/document.pdf' };
  draft.native = JSON.stringify(body);
  if (id === 'transcription') draft.files = [new File(['synthetic-audio'], 'fixture.wav', { type: 'audio/wav' })];
  return { operation, draft, prepared: prepareRequest(operation, draft) };
}

describe('native gateway operation contracts', () => {
  it.each(OPERATIONS.map(operation => operation.id))('%s composes its implemented same-origin gateway path', id => {
    const { operation, prepared } = fixture(id);
    expect(prepared.url.startsWith(operation.path)).toBe(true);
    expect(prepared.method).toBe(operation.method || 'POST');
    expect(prepared.headers.Authorization).toBeUndefined();
  });
  it('preserves advanced native options and sets streaming at the Gemini URL boundary', () => {
    const { operation, draft } = fixture('gemini', { stream: true });
    draft.native = JSON.stringify({ contents: [{ parts: [{ text: 'Synthetic' }] }], generationConfig: { temperature: 0.2 }, tools: [] });
    const request = prepareRequest(operation, draft);
    expect(request.url).toBe('/v1beta/models/gemini/synthetic:streamGenerateContent?alt=sse');
    expect(JSON.parse(request.body).generationConfig).toEqual({ temperature: 0.2 });
  });
  it('repeats STT granularities and leaves multipart Content-Type to the browser', () => {
    const { operation, draft } = fixture('transcription');
    draft.native = JSON.stringify({ model: 'synthetic/whisper', 'timestamp_granularities[]': ['word', 'segment'], language: 'en' });
    const request = prepareRequest(operation, draft);
    expect(request.body.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(request.body.get('file').name).toBe('fixture.wav');
    expect(request.headers['Content-Type']).toBeUndefined();
  });
  it('retains video account binding, idempotency and opaque poll identity', () => {
    const { prepared } = fixture('video-generate', { connection: 'account-a', idempotency: 'logical-create-a' });
    expect(prepared.headers).toMatchObject({ 'x-tokenproxy-connection-id': 'account-a', 'Idempotency-Key': 'logical-create-a' });
    expect(fixture('video-poll', { jobId: 'veo:models/a/operations/b', connection: 'account-a' }).prepared.url).toBe('/v1/videos/veo%3Amodels%2Fa%2Foperations%2Fb');
  });
  it('refuses nonexistent Gemini edit semantics, unsupported video adapters and image URL/mask shortcuts', () => {
    const { operation, draft } = fixture('video-edit');
    draft.native = JSON.stringify({ model: 'gemini/veo', prompt: 'Synthetic' });
    expect(() => prepareRequest(operation, draft)).toThrow('distinct edit');
    draft.native = JSON.stringify({ model: 'runwayml/declared-only', prompt: 'Synthetic' });
    expect(() => prepareRequest(operation, draft)).toThrow('Only xAI');
    const image = fixture('image-edit');
    image.draft.native = JSON.stringify({ model: 'synthetic/model', prompt: 'Synthetic', image: 'https://example.invalid/image.png' });
    expect(() => prepareRequest(image.operation, image.draft)).toThrow('remote URLs');
    image.draft.native = JSON.stringify({ model: 'synthetic/model', prompt: 'Synthetic', mask: 'data:image/png;base64,AA==' });
    expect(() => prepareRequest(image.operation, image.draft)).toThrow('masks');
  });
  it('rejects invalid JSON shapes, credential fields, image bounds and malformed rerank inputs before fetch', () => {
    const { operation, draft } = fixture('chat');
    for (const native of ['{', '[]', '{"api_key":"synthetic-secret"}']) expect(() => prepareRequest(operation, { ...draft, native })).toThrow();
    const image = fixture('image-edit');
    expect(() => prepareRequest(image.operation, { ...image.draft, encoding: 'multipart', files: [{ size: 21 * 1024 * 1024 }] })).toThrow('20 MiB');
    const rank = fixture('rerank');
    expect(() => prepareRequest(rank.operation, { ...rank.draft, native: JSON.stringify({ model: 'cohere/synthetic', query: 'Synthetic', documents: [42] }) })).toThrow('documents');
  });
});

describe('one explicit cancellable request with bounded evidence', () => {
  it('sends one bearer request, refuses redirects, and redacts body/header/escaped echoes before export', async () => {
    const key = 'synthetic-secret-key';
    const fetchImpl = vi.fn(async () => new Response('{"content":"synthetic-secret-key","encoded":"\\u0073ynthetic-secret-key"}', { headers: { 'content-type': `application/json; echoed=${key}`, 'x-request-id': key } }));
    const controller = new AbortController();
    const result = await sendGateway(fixture('chat').prepared, { clientKey: key, signal: controller.signal, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Authorization: `Bearer ${key}` } });
    expect(JSON.stringify({ ...result, blob: null })).not.toContain(key);
    expect(await result.blob.text()).not.toContain(key);
    expect(JSON.stringify(diagnosticExport(result))).not.toContain(key);
  });
  it('never retries HTTP refusals, aborts or uncertain transport failures', async () => {
    const failure = vi.fn(async () => { throw new TypeError('Synthetic disconnected transport'); });
    await expect(sendGateway(fixture('video-generate').prepared, { clientKey: 'synthetic-key', signal: new AbortController().signal, fetchImpl: failure })).rejects.toThrow('disconnected');
    expect(failure).toHaveBeenCalledTimes(1);
    const denied = vi.fn(async () => Response.json({ error: 'Synthetic denied' }, { status: 403 }));
    expect((await sendGateway(fixture('chat').prepared, { clientKey: 'synthetic-key', fetchImpl: denied })).status).toBe(403);
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('stops oversized response reading and never offers truncated binary as a complete download', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); }, cancel }), { headers: { 'content-type': 'image/png' } });
    const result = await sendGateway(fixture('image-generate').prepared, { clientKey: 'synthetic-key', fetchImpl: async () => response });
    expect(result).toMatchObject({ bytes: MAX_RESPONSE_BYTES, truncated: true, blob: null });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('keeps large JSON response data within the byte bound while bounding only its visible text', async () => {
    const data = { data: [{ b64_json: 'A'.repeat(120000) }] };
    const result = await sendGateway(fixture('image-generate').prepared, { clientKey: 'synthetic-key', fetchImpl: async () => Response.json(data) });
    expect(result.viewTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.text).toHaveLength(100000);
    expect(result.data).toEqual(data);
    expect(await result.blob.text()).toHaveLength(JSON.stringify(data, null, 2).length);
  });
  it('rejects credentials misplaced into request content and non-gateway targets without a call', async () => {
    const fetchImpl = vi.fn();
    const { prepared } = fixture('chat');
    await expect(sendGateway({ ...prepared, url: 'https://example.invalid/collect' }, { clientKey: 'synthetic-key', fetchImpl })).rejects.toThrow('same-origin');
    await expect(sendGateway({ ...prepared, nativeBody: { model: 'synthetic-key' } }, { clientKey: 'synthetic-key', fetchImpl })).rejects.toThrow('authorization header');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
