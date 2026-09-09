// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/shared/api', () => ({ call: vi.fn() }));
import { call } from '@/shared/api';
import { importPasted, runGrant, credentialDocument } from '@/shared/oauthGrant';
import { refusal } from '@/shared/refusal';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const popupStub = () => {
  const popup = { location: { href: '' }, closed: false, close: vi.fn() };
  vi.stubGlobal('open', vi.fn(() => popup));
  return popup;
};

it('carries Kiro registration metadata through device polling without exposing it to display state', async () => {
  vi.useFakeTimers();
  const device = { deviceCode: 'fixture-device', userCode: 'FIXTURE', verificationUri: 'https://fixture.invalid',
    codeVerifier: 'fixture-verifier', interval: 2, _clientId: 'fixture-client', _clientSecret: 'fixture-secret',
    _region: 'eu-west-1', _authMethod: 'idc', _startUrl: 'https://fixture.invalid/start' };
  call.mockResolvedValueOnce({ ok: true, body: device }).mockResolvedValueOnce({ ok: true, body: { success: true, connection: { id: 'fixture-account' } } });
  const deviceHook = vi.fn();
  const pending = runGrant('kiro', 'device_code', { deviceHook, deviceOptions: { region: 'eu-west-1', authMethod: 'idc', startUrl: 'https://fixture.invalid/start' } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ ok: true, connection: { id: 'fixture-account' } });
  expect(call.mock.calls[0][0]).toContain('region=eu-west-1');
  expect(call.mock.calls[1][1].body.extraData).toMatchObject({ _clientId: device._clientId, _clientSecret: device._clientSecret, _region: device._region, _authMethod: 'idc' });
  expect(JSON.stringify(deviceHook.mock.calls)).not.toContain(device._clientSecret);
});

it('renews Cursor credentials on the selected account instead of importing another account', async () => {
  call.mockResolvedValue({ ok: true, body: { connection: { id: 'fixture-existing' } } });
  const result = await importPasted('cursor', { token: 'fixture-token', machineId: 'fixture-machine', reauth: { reauthConnectionId: 'fixture-existing', forceReauth: true } });
  expect(call).toHaveBeenCalledWith('/api/providers/fixture-existing/reauth', { method: 'POST', body: {
    accessToken: 'fixture-token', providerSpecificData: { machineId: 'fixture-machine' }, force: true,
  } });
  expect(result).toMatchObject({ ok: true, connection: { id: 'fixture-existing' } });
});

it('refuses fixed callback renewal before opening a new-account flow and accepts one replacement document', async () => {
  expect(await runGrant('codex', 'authorization_code_pkce', { reauth: { reauthConnectionId: 'fixture-existing' } })).toMatchObject({ ok: false, status: 409 });
  expect(call).not.toHaveBeenCalled();
  expect(credentialDocument(JSON.stringify({ accounts: [{ provider: 'codex', refreshToken: 'fixture-refresh' }] }), true)).toEqual({ provider: 'codex', refreshToken: 'fixture-refresh', force: true });
  expect(() => credentialDocument(JSON.stringify({ accounts: [{}, {}] }))).toThrow('exactly one');
  expect(() => credentialDocument('{}')).toThrow('no usable credential');
});

it('opens the sign-in window inside the click and relays the callback code into the exchange', async () => {
  const popup = popupStub();
  let releaseAuthorize;
  call.mockImplementationOnce(() => new Promise((resolve) => { releaseAuthorize = resolve; }));
  const pending = runGrant('claude', 'authorization_code_pkce', {});
  // Opened before the authorize round trip resolves, so it still carries the click's
  // user activation; `noopener` stays off because the callback page relays through
  // window.opener.postMessage.
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(window.open.mock.calls[0][0]).toBe('about:blank');
  expect(String(window.open.mock.calls[0][2] || '')).not.toContain('noopener');
  call.mockResolvedValueOnce({ ok: true, body: { success: true, connection: { id: 'fixture-account' } } });
  releaseAuthorize({ ok: true, body: { authUrl: 'https://provider.invalid/authorize', state: 'fixture-state',
    codeVerifier: 'fixture-verifier', redirectUri: 'http://localhost/callback', flowType: 'authorization_code_pkce' } });
  await tick();
  expect(popup.location.href).toBe('https://provider.invalid/authorize');
  window.dispatchEvent(new StorageEvent('storage', { key: 'oauth_callback',
    newValue: JSON.stringify({ code: 'fixture-code', state: 'fixture-state', timestamp: Date.now() }) }));
  expect(await pending).toMatchObject({ ok: true, connection: { id: 'fixture-account' } });
  expect(call.mock.calls[1][1].body).toMatchObject({ code: 'fixture-code', state: 'fixture-state',
    redirectUri: 'http://localhost/callback', codeVerifier: 'fixture-verifier' });
});

it('reports a blocked sign-in window instead of waiting on one that never opened', async () => {
  vi.stubGlobal('open', vi.fn(() => null));
  const out = await runGrant('claude', 'authorization_code_pkce', {});
  expect(out).toMatchObject({ ok: false, status: 0 });
  expect(out.body.error).toMatch(/pop-ups/i);
  expect(call).not.toHaveBeenCalled();
});

it('starts the codex callback proxy on the provider loopback URI and names the dashboard port', async () => {
  vi.useFakeTimers();
  const popup = popupStub();
  call
    .mockResolvedValueOnce({ ok: true, body: { authUrl: 'https://auth.openai.invalid/authorize', state: 'fixture-state',
      codeVerifier: 'fixture-verifier', redirectUri: 'http://localhost:1455/auth/callback', fixedPort: 1455,
      flowType: 'authorization_code_pkce' } })
    .mockResolvedValueOnce({ ok: true, body: { success: true, serverSide: true } })
    .mockResolvedValueOnce({ ok: true, body: { status: 'done', connectionId: 'fixture-account', email: 'fixture@example.invalid' } })
    .mockResolvedValueOnce({ ok: true, body: { success: true } });
  const pending = runGrant('codex', 'authorization_code_pkce', {});
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ ok: true, connection: { id: 'fixture-account' } });
  const startProxy = new URL(call.mock.calls[1][0], 'http://dashboard.invalid');
  expect(startProxy.pathname).toBe('/api/oauth/codex/start-proxy');
  // The session registered here is exchanged against later, so it carries the URI the
  // authorize URL was built with, never the dashboard origin.
  expect(startProxy.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  // app_port is the dashboard's own port; the proxy 302s its channel fallback there.
  expect(startProxy.searchParams.get('app_port')).toBe(String(window.location.port || 80));
  expect(startProxy.searchParams.get('app_port')).not.toBe('1455');
  expect(popup.location.href).toBe('https://auth.openai.invalid/authorize');
});

it('renders a grant refusal as its own sentence instead of blaming an unreachable gateway', async () => {
  vi.stubGlobal('open', vi.fn(() => null));
  const blocked = await runGrant('claude', 'authorization_code_pkce', {});
  // Every browser-side grant refusal carries status 0, which used to collapse into
  // "The gateway did not answer" and send the operator to restart a healthy service.
  expect(blocked.status).toBe(0);
  expect(refusal(blocked.status, blocked.body).title).toBe(blocked.body.error);
  expect(refusal(0, { error: 'The provider refused the sign-in.' }).title).toBe('The provider refused the sign-in.');
  // call()'s own transport envelope still reads as an unreachable gateway.
  expect(refusal(0, { error: 'fetch failed', code: 'network' }).title).toBe('The gateway did not answer.');
  expect(refusal(0, {}).title).toBe('The gateway did not answer.');
});
