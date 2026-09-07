import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  importDb: vi.fn(),
  getSettings: vi.fn(),
  apply: vi.fn(),
  password: vi.fn(),
  identity: vi.fn(),
}));
vi.mock('next/server', () => ({
  NextResponse: { json: (value, init) => Response.json(value, init) },
}));
vi.mock('@/lib/localDb', () => ({
  importDb: mocks.importDb,
  exportDb: vi.fn(),
  getSettings: mocks.getSettings,
}));
vi.mock('@/lib/network/outboundProxy', () => ({ applyOutboundProxyEnv: mocks.apply }));
vi.mock('@/lib/auth/dashboardSession', () => ({
  verifyDashboardPassword: mocks.password,
  verifyDashboardAuthToken: vi.fn(),
}));
vi.mock('@/dashboardGuard', () => ({ hasValidCliToken: mocks.identity }));
const { POST } = await import('@/app/api/settings/database/route.js');
const request = () =>
  new Request('http://localhost/api/settings/database', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic-password', settings: {} }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.password.mockResolvedValue(true);
  mocks.identity.mockResolvedValue(true);
  mocks.getSettings.mockResolvedValue({});
  mocks.apply.mockReset();
});
it('reports committed import and failed process refresh separately without repeating import', async () => {
  mocks.apply.mockImplementation(() => {
    throw new Error('synthetic refresh failure');
  });
  const response = await POST(request());
  expect(response.status).toBe(207);
  expect(await response.json()).toMatchObject({
    success: true,
    outcome: 'partial',
    completion: { databaseImported: true, outboundProxyEnvironment: 'failed' },
  });
  expect(mocks.importDb).toHaveBeenCalledTimes(1);
});
it('reports complete local phases when both succeed, and refuses missing identity before mutation', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect((await response.json()).completion.outboundProxyEnvironment).toBe('applied');
  mocks.importDb.mockClear();
  mocks.identity.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.importDb).not.toHaveBeenCalled();
});
