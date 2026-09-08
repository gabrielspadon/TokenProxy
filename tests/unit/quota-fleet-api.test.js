import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), capture: vi.fn(), history: vi.fn() }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.guard }));
vi.mock('@/lib/admin/routingCapture.js', () => ({ captureRoutingState: mocks.capture }));
vi.mock('@/lib/db/repos/quotaWorkbenchRepo.js', () => ({ getQuotaWorkbench: mocks.history }));
import { POST } from '@/app/api/admin/quota/scenario/route.js';
import { createRoutingCapture } from '@/lib/routingSimulation.js';
import { configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
const document = { combos: [], aliases: {}, settings: {} };
const input = { model: 'cx/test' }, now = '2026-09-08T10:25:00.000Z';
const routing = createRoutingCapture({ capturedAt: now, scope: { requestedModel: input.model, model: 'test', provider: 'codex' }, accounts: [],
  settings: { disabledProviders: {}, providerStrategies: {} }, disabledModels: {}, providerNodes: [], drains: {}, activeLoad: {}, pin: null,
  affinitySource: 'assumed-new-session', capabilities: {}, configuration: { scope: CONFIG_SCOPE, currentHash: configHash(document), document } });
const request = body => new Request('http://localhost/api/admin/quota/scenario', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(null); mocks.capture.mockResolvedValue({ capture: routing, input }); });
describe('fleet scenario administrative API', () => {
  it('checks authorization before reading a capture and does not return private capture errors', async () => {
    mocks.guard.mockResolvedValue(new Response('denied', { status: 403 }));
    expect((await POST(request({ operation: 'capture', input }))).status).toBe(403);
    expect(mocks.capture).not.toHaveBeenCalled();
    mocks.guard.mockResolvedValue(null); mocks.capture.mockRejectedValue(new Error('private credential path'));
    const response = await POST(request({ operation: 'capture', input }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private credential');
  });
  it('captures an empty fleet and replays it through the real comparison with no-store responses', async () => {
    const captured = await POST(request({ operation: 'capture', input }));
    expect(captured.status).toBe(200);
    expect(captured.headers.get('cache-control')).toContain('no-store');
    const payload = await captured.json();
    expect(payload.comparison.accounts).toEqual([]);
    const compared = await POST(request({ operation: 'compare', capture: payload.capture, input, scenario: { hours: 3 } }));
    expect(compared.status).toBe(200);
    expect((await compared.json()).projectionPeriod.hours).toBe(3);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
  it('refuses unknown fields, malformed JSON, oversized bodies and future history ranges', async () => {
    for (const body of [{ operation: 'capture', input, apiKey: 'never' }, { operation: 'oops' }, { operation: 'capture', input, end: '2099-01-01T00:00:00.000Z' }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect((await POST(new Request('http://localhost/api/admin/quota/scenario', { method: 'POST', body: '{' }))).status).toBe(400);
    expect((await POST(request({ operation: 'capture', input, padding: 'x'.repeat(4 * 1024 * 1024) }))).status).toBe(413);
  });
});
