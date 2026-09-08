import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const health = vi.hoisted(() => ({ connections: vi.fn(), denied: vi.fn() }));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: async () => ({ driver: 'synthetic', get: () => ({ ok: 1 }) }) }));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({ getProviderConnections: health.connections }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: health.denied }));
vi.mock('@/lib/admin/state.js', () => ({ readAllDrainDocs: async () => ({}) }));
vi.mock('@/lib/admin/project.js', () => ({ toConnection: value => value }));
import { GET } from '@/app/api/admin/health/detail/route';

beforeEach(() => {
  health.denied.mockResolvedValue(null);
  health.connections.mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('projects failed connection scans separately from an observed empty inventory', async () => {
  let response = await GET(new Request('http://localhost/api/admin/health/detail'));
  expect(await response.json()).toMatchObject({ status: 'ok', scanFailed: false, checks: { connections: [] } });
  health.connections.mockRejectedValueOnce(new Error('Synthetic scan failure'));
  response = await GET(new Request('http://localhost/api/admin/health/detail'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'error', scanFailed: true, checks: { connections: [], database: { status: 'ok' } } });
  expect(fetch).not.toHaveBeenCalled();
});

it('retains the admin permission refusal without reading readiness', async () => {
  health.denied.mockResolvedValueOnce(Response.json({ code: 'unauthorized' }, { status: 401 }));
  expect((await GET(new Request('http://localhost/api/admin/health/detail'))).status).toBe(401);
  expect(health.connections).not.toHaveBeenCalled();
});
