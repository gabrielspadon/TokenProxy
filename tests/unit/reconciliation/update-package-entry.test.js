import { describe, it, expect, vi, beforeEach } from 'vitest';

// update.package.entry — boundary-contract.json, owner claude/.claude/shared/bin/update-9router.sh
// "source release staging". Mutations this test must catch: "activate
// without lock graph", "skip runtime patch", "accept unexpected package
// version".
//
// TokenProxy's admin ABI has no create-release operation (docs/reconciliation/
// admin-abi.json, POST /api/admin/activation): a release becomes known to
// TokenProxy by being written into the shared release catalog during
// staging, before this endpoint is ever called. Staging (update-9router.sh,
// out of scope for this file) is what runs the schema, runtime-patch and
// managed-module checks; the one thing this ABI owns is honoring the verdict
// staging wrote — refusing to activate anything staging did not mark passed,
// and refusing anything staging never registered at all. That precondition
// (src/app/api/admin/activation/route.js, `target.status === "failed"`) is
// the entry gate every one of the three mutations above tries to defeat: each
// would, if it slipped through, leave a release on file that either failed
// its check or was never checked, and this file proves activation refuses
// both.
//
// Every fixture below is synthetic; nothing is read from the environment.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
}));

const store = new Map();
const snapshot = () => JSON.stringify([...store.entries()].sort());

import { makeMemoryKv } from './kvMemory.js';

vi.mock('next/server', () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock('@/lib/db/helpers/kvStore.js', () => ({ makeKv: makeMemoryKv(store) }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db/version.js', () => ({ getAppVersion: () => '0.0.1' }));

const { POST: ACTIVATE, GET: ACTIVATION_GET } = await import('@/app/api/admin/activation/route.js');

const req = (body) => ({ text: async () => (body === undefined ? '' : JSON.stringify(body)) });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  mocks.requireAdmin.mockResolvedValue(null);
});

// The release catalog as staging would have written it directly, before this
// ABI's activation endpoint is ever called.
function seedStagedCatalog() {
  store.set(
    'admin.activation:history',
    JSON.stringify([
      {
        releaseId: 'rel-2.4.0',
        version: '2.4.0',
        status: 'pending',
        activatedAt: null,
        previousReleaseId: null,
      },
      {
        releaseId: 'rel-2.4.0-bad',
        version: '2.4.0-bad',
        status: 'failed',
        activatedAt: null,
        previousReleaseId: null,
      },
    ])
  );
}

describe('update.package.entry', () => {
  it('update.package.entry: activates a staged release on file with a passing status', async () => {
    seedStagedCatalog();
    const res = await ACTIVATE(req({ releaseId: 'rel-2.4.0' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.releaseId).toBe('rel-2.4.0');
    // The exact staged version, never coerced or substituted — the check an
    // "accept unexpected package version" mutation would try to defeat.
    expect(body.version).toBe('2.4.0');
  });

  it('update.package.entry: refuses a release staged with status failed, and writes nothing', async () => {
    seedStagedCatalog();
    const before = snapshot();
    const res = await ACTIVATE(req({ releaseId: 'rel-2.4.0-bad' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('precondition_failed');
    expect(snapshot()).toBe(before);

    const after = await ACTIVATION_GET(req());
    const afterBody = await after.json();
    expect(afterBody.active.releaseId).not.toBe('rel-2.4.0-bad');
  });

  it('update.package.entry: refuses a releaseId staging never registered, rather than activating it, and writes nothing', async () => {
    seedStagedCatalog();
    const before = snapshot();
    const res = await ACTIVATE(req({ releaseId: 'rel-never-staged' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('not_found');
    expect(snapshot()).toBe(before);
  });
});
