// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/shared/api', () => ({ call: vi.fn() }));
import { call } from '@/shared/api';
import { importPasted, runGrant, credentialDocument } from '@/shared/oauthGrant';

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

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
