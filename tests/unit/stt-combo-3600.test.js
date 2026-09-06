import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({ handleSttCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock('open-sse/index.js', () => ({}));
vi.mock('@/sse/services/auth.js', () => ({
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: authMocks.isValidApiKey,
  markAccountUnavailable: authMocks.markAccountUnavailable,
}));
vi.mock('open-sse/handlers/sttCore.js', () => ({ handleSttCore: coreMocks.handleSttCore }));
vi.mock('@/sse/services/model.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock('@/lib/localDb', () => settingsMocks);
vi.mock('@/sse/services/apiKeyDevices.js', () => ({ recordApiKeyDevice: vi.fn() }));
vi.mock('@/sse/services/modelAccess.js', () => ({
  refuseDisallowedModel: vi.fn(async () => null),
}));
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(() => '***'),
  request: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/shared/constants/providers', () => ({
  AI_PROVIDERS: { demo: { id: 'demo', serviceKinds: ['stt'], sttConfig: { authType: 'none' } } },
  resolveProviderId: vi.fn((provider) => provider),
}));

const { handleStt } = await import('@/sse/handlers/stt.js');

function sttRequest(model) {
  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob(['audio']), 'audio.wav');
  return new Request('http://router.test/v1/audio/transcriptions', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettings.mockResolvedValue({});
  modelMocks.getModelInfo.mockImplementation(async (name) => {
    const [provider, model] = String(name).split('/');
    return { provider, model };
  });
  modelMocks.getComboModels.mockResolvedValue(null);
});

// #3600: combo expansion reached every modality handler except speech-to-text,
// so a combo name posted to /v1/audio/transcriptions was parsed as a literal
// "provider/model" and failed instead of falling back across its members.
describe('STT combo expansion (#3600)', () => {
  it('falls back to the next combo member when the first fails', async () => {
    modelMocks.getComboModels.mockResolvedValue(['demo/whisper-a', 'demo/whisper-b']);
    coreMocks.handleSttCore
      .mockResolvedValueOnce({ success: false, failureMetadata: { safeToReplay: true }, status: 500, error: 'upstream down' })
      .mockResolvedValueOnce({ success: true, response: Response.json({ text: 'ok' }) });

    const response = await handleStt(sttRequest('my-stt-combo'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: 'ok' });
    expect(coreMocks.handleSttCore).toHaveBeenCalledTimes(2);
    expect(coreMocks.handleSttCore.mock.calls.map((c) => c[0].model)).toEqual([
      'whisper-a',
      'whisper-b',
    ]);
  });

  it('still routes a plain model straight through', async () => {
    coreMocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: 'ok' }),
    });

    const response = await handleStt(sttRequest('demo/whisper-a'));

    expect(response.status).toBe(200);
    expect(coreMocks.handleSttCore).toHaveBeenCalledTimes(1);
  });
});
