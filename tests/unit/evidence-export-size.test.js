import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_LIMITS, serializeEvidence } from '../../src/lib/db/analytics/evidenceFormat.mjs';
import { INITIAL_SCOPE } from '../../src/lib/db/analytics/investigationModel.mjs';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/lib/admin/guard', () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('../../src/lib/db/driver', () => ({ getAdapter: vi.fn(async () => ({ driver: 'node:sqlite' })) }));
vi.mock('../../src/lib/db/analytics/client', () => ({ readContextAnalytics: mocks.read }));
const { POST } = await import('../../src/app/api/admin/investigations/export/route');

function sizedPayload(bytes, pretty = false) {
  const payload = { manifest: { complete: true, source: 'synthetic boundary fixture' }, items: [{ evidence: '' }] };
  const overhead = Buffer.byteLength(JSON.stringify(payload, null, pretty ? 2 : undefined));
  payload.items[0].evidence = 'a'.repeat(bytes - overhead);
  return payload;
}
function request() {
  return new Request('http://localhost/api/admin/investigations/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'selected', definition: { schemaVersion: 1, lens: 'economics', scope: INITIAL_SCOPE, comparisonIds: [], selection: { kind: 'economics-record', id: '1' } } }),
  });
}
beforeEach(() => vi.clearAllMocks());

describe('Final UTF-8 evidence size', () => {
  it('accepts exactly 8 MiB and refuses the next byte without shortening evidence', () => {
    const payload = sizedPayload(EXPORT_LIMITS.bytes);
    expect(Buffer.byteLength(serializeEvidence(payload))).toBe(EXPORT_LIMITS.bytes);
    payload.items[0].evidence += 'a';
    expect(() => serializeEvidence(payload)).toThrow(expect.objectContaining({ code: 'export_too_large', status: 413 }));
    expect(payload.items[0].evidence.endsWith('aa')).toBe(true);
  });
  it('counts multibyte values as UTF-8 rather than string code units', () => {
    const payload = sizedPayload(EXPORT_LIMITS.bytes - 3);
    payload.items[0].evidence += '🚢';
    expect(JSON.stringify(payload).length).toBeLessThan(EXPORT_LIMITS.bytes);
    expect(() => serializeEvidence(payload)).toThrow(/exceeds 8 MiB/);
  });
  it('includes indentation and preview metadata in the download boundary', () => {
    const payload = sizedPayload(EXPORT_LIMITS.bytes, true);
    expect(Buffer.byteLength(serializeEvidence(payload, true))).toBe(EXPORT_LIMITS.bytes);
    payload.manifest.preview = { kind: 'synthetic-fixture', capturedAt: '2026-09-06T15:45:00.000Z' };
    expect(() => serializeEvidence(payload, true)).toThrow(/including metadata and formatting/);
    expect(payload.manifest.preview.kind).toBe('synthetic-fixture');
  });
  it('returns the exact allowed serialized response with no-store', async () => {
    const payload = sizedPayload(EXPORT_LIMITS.bytes);
    mocks.read.mockResolvedValue(payload);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.arrayBuffer()).byteLength).toBe(EXPORT_LIMITS.bytes);
  });
  it('refuses a worker result pushed over the cap by the freshness envelope', async () => {
    const payload = sizedPayload(EXPORT_LIMITS.bytes);
    payload.freshness = { source: 'committed-sqlite', snapshotCompletedAt: '2026-09-06T15:45:00.000Z' };
    mocks.read.mockResolvedValue(payload);
    const response = await POST(request());
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'export_too_large', source: 'tokenproxy-admin' });
    expect(body).not.toHaveProperty('items');
    expect(body.error).toContain('no partial export');
  });
});
