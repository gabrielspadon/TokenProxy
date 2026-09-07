import { beforeEach, expect, it, vi } from 'vitest';
import * as translator from 'open-sse/translator/index.js';
import { DefaultExecutor } from 'open-sse/executors/default.js';
const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  executor: vi.fn(),
}));
vi.mock('next/server', () => ({
  NextResponse: { json: (value, init) => Response.json(value, init) },
}));
vi.mock('@/sse/services/model.js', () => ({
  getModelInfo: async () => ({ provider: 'fixture', model: 'synthetic-model' }),
}));
vi.mock('@/lib/localDb.js', () => ({ getProviderConnections: mocks.connection }));
vi.mock('open-sse/executors/index.js', () => ({ getExecutor: mocks.executor }));
const realTranslate = translator.translateRequest;
const realRoute = translator.describeTranslationRoute;
mocks.translate = vi.spyOn(translator, 'translateRequest');
mocks.route = vi.spyOn(translator, 'describeTranslationRoute');
const { POST } = await import('@/app/api/translator/translate/route.js');
const send = (step, body) =>
  POST(
    new Request('http://localhost/api/translator/translate', {
      method: 'POST',
      body: JSON.stringify({ step, body }),
    })
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockReturnValue({
    supported: true,
    mode: 'direct',
    edges: [{ from: 'openai', to: 'claude' }],
  });
  mocks.translate.mockImplementation(() => ({ messages: [] }));
  mocks.connection.mockResolvedValue([
    { id: 'synthetic-account', apiKey: 'plain-synthetic-credential' },
  ]);
  mocks.executor.mockReturnValue({
    buildUrl: () => 'https://name:pass@example.invalid/messages?key=private',
    buildHeaders: () => ({
      Authorization: 'Bearer plain-synthetic-credential',
      'x-api-key': 'plain-synthetic-credential',
      'content-type': 'application/json',
    }),
    transformRequest: () => ({ messages: [], custom: 'plain-synthetic-credential' }),
    execute: () => {
      throw new Error('forbidden');
    },
  });
});
it('returns route registration evidence without reading credentials for format detection', async () => {
  const response = await send(1, { model: 'fixture/model', messages: [] });
  expect((await response.json()).result).toMatchObject({
    route: { mode: 'direct' },
    providerCalls: 0,
  });
  expect(mocks.connection).not.toHaveBeenCalled();
});
it('refuses an unavailable local edge before translation or account lookup', async () => {
  mocks.route.mockReturnValue({ supported: false, mode: 'unavailable' });
  const response = await send(2, { model: 'fixture/model', messages: [] });
  expect(response.status).toBe(422);
  expect(mocks.translate).not.toHaveBeenCalled();
  expect(mocks.connection).not.toHaveBeenCalled();
});
it('constructs local target diagnostics with header, URL and body credentials removed', async () => {
  const response = await send(3, {
    provider: 'fixture',
    model: 'synthetic-model',
    body: { messages: [] },
  });
  const packet = await response.json();
  expect(response.status).toBe(200);
  expect(packet.result).toMatchObject({
    scope: 'local-executor-construction',
    credentialsRead: true,
    providerCalls: 0,
    headers: { 'content-type': 'application/json' },
    body: { custom: '[redacted]' },
  });
  const encoded = JSON.stringify(packet);
  expect(encoded).not.toContain('plain-synthetic-credential');
  expect(encoded).not.toContain('name:pass');
  expect(encoded).not.toContain('key=private');
});

it('preserves chat text and configured URLs while redacting credential values in custom output fields', async () => {
  const baseUrl = 'https://example.invalid/v1';
  const text = `Keep this chat message and ${baseUrl} unchanged.`;
  const credentialValues = [
    'plain-synthetic-credential',
    'nested-synthetic-secret',
    'nested-synthetic-copilot',
  ];
  mocks.connection.mockResolvedValue([{
    id: 'synthetic-account',
    apiKey: credentialValues[0],
    providerSpecificData: {
      apiType: 'chat',
      baseUrl,
      auth: { clientSecret: credentialValues[1] },
      copilotToken: credentialValues[2],
    },
  }]);
  mocks.executor.mockReturnValue({
    buildUrl: () => `${baseUrl}/chat/completions`,
    buildHeaders: () => ({ 'content-type': 'application/json' }),
    transformRequest: () => ({
      messages: [{ role: 'user', content: text }],
      custom: credentialValues.map(value => ({ echoed: `value=${value}` })),
    }),
    execute: vi.fn(() => { throw new Error('forbidden'); }),
  });
  const response = await send(3, {
    provider: 'openai-compatible-chat-synthetic',
    model: 'synthetic-model',
    body: { messages: [{ role: 'user', content: text }] },
  });
  const packet = await response.json();
  expect(response.status).toBe(200);
  expect(packet.result.url).toBe(`${baseUrl}/chat/completions`);
  expect(packet.result.body.messages).toEqual([{ role: 'user', content: text }]);
  expect(packet.result.body.custom).toEqual(credentialValues.map(() => ({ echoed: 'value=[redacted]' })));
  for (const secret of credentialValues) expect(JSON.stringify(packet)).not.toContain(secret);
  expect(mocks.executor.mock.results[0].value.execute).not.toHaveBeenCalled();
});

it('uses the stored Responses API type for the registered route, translated body and executor URL', async () => {
  const provider = 'openai-compatible-chat-synthetic';
  const model = 'synthetic-model';
  const executor = new DefaultExecutor(provider);
  const execute = vi.spyOn(executor, 'execute').mockImplementation(() => { throw new Error('forbidden'); });
  mocks.executor.mockReturnValue(executor);
  mocks.route.mockImplementation(realRoute);
  mocks.translate.mockImplementation(realTranslate);
  mocks.connection.mockResolvedValue([
    { id: 'inactive-chat-account', isActive: false, providerSpecificData: { apiType: 'chat' } },
    {
      id: 'synthetic-responses-account',
      apiKey: 'plain-synthetic-credential',
      providerSpecificData: { apiType: 'responses', baseUrl: 'https://example.invalid/v1' },
    },
  ]);
  const response = await send(3, {
    provider,
    model,
    body: { messages: [{ role: 'user', content: 'A synthetic chat message.' }], stream: false },
  });
  const packet = await response.json();
  expect(response.status).toBe(200);
  expect(packet.result).toMatchObject({
    connectionId: 'synthetic-responses-account',
    url: 'https://example.invalid/v1/responses',
    sourceFormat: 'openai',
    targetFormat: 'openai-responses',
    route: { supported: true, mode: 'direct', edges: [{ from: 'openai', to: 'openai-responses' }] },
    body: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A synthetic chat message.' }] }] },
    providerCalls: 0,
  });
  expect(packet.result.body).not.toHaveProperty('messages');
  expect(mocks.translate).toHaveBeenCalledWith('openai', 'openai-responses', model,
    expect.any(Object), false, expect.objectContaining({ providerSpecificData: { apiType: 'responses', baseUrl: 'https://example.invalid/v1' } }), provider);
  expect(execute).not.toHaveBeenCalled();
});
