import { describe, it, expect, vi, beforeEach } from 'vitest';

// update.rollback.exit — boundary-contract.json, owner claude/.claude/shared/bin/update-9router.sh
// "activation rollback". Mutations this test must catch: "delete last good
// state", "restart unsafe legacy proxy", "report success after failed
// health".
//
// TWO OF THE THREE ARE TESTABLE FROM THIS SURFACE. "delete last good state"
// and "report success after failed health" are both about what POST
// /api/admin/rollback (src/app/api/admin/rollback/route.js) is allowed to
// answer and what it is allowed to touch, and both are exercised below: a
// rollback restores the exact prior release byte-for-byte and leaves every
// other scope in the store untouched, and it refuses (409/404) rather than
// fabricating a 200 whenever there is no catalog-known release to land on.
// "restart unsafe legacy proxy" is NOT testable here: TokenProxy's admin ABI
// has no operation that starts, stops or restarts any process, legacy or
// otherwise — that lifecycle decision belongs to update-9router.sh itself,
// which this task is scoped to leave untested. Named here rather than
// silently dropped.
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
const { POST: ROLLBACK } = await import('@/app/api/admin/rollback/route.js');

const req = (body) => ({ text: async () => (body === undefined ? '' : JSON.stringify(body)) });

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  mocks.requireAdmin.mockResolvedValue(null);
});

// The prior application: release A, active and on file, plus unrelated
// operator state (a drain record) that a rollback has no business touching.
function seedPriorApplication() {
  store.set(
    'admin.activation:current',
    JSON.stringify({
      releaseId: 'rel-A',
      version: '1.0.0',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      previousReleaseId: null,
    })
  );
  store.set(
    'admin.activation:history',
    JSON.stringify([
      {
        releaseId: 'rel-A',
        version: '1.0.0',
        status: 'active',
        activatedAt: '2026-01-01T00:00:00.000Z',
        previousReleaseId: null,
        action: 'activate',
      },
      {
        releaseId: 'rel-B',
        version: '2.0.0',
        status: 'pending',
        activatedAt: null,
        previousReleaseId: null,
      },
    ])
  );
  store.set(
    'admin.drain:conn-1',
    JSON.stringify({ isDraining: false, requestedAt: null, completedAt: null })
  );
}

describe('update.rollback.exit', () => {
  it('update.rollback.exit: restores the exact prior release after a failed activation, byte for byte', async () => {
    seedPriorApplication();
    const drainBefore = store.get('admin.drain:conn-1');

    // rel-B ships and becomes active — the deploy this rollback undoes.
    const activated = await ACTIVATE(req({ releaseId: 'rel-B' }));
    expect(activated.status).toBe(200);

    // Its health failed; roll back with no explicit target, the operator's
    // "undo that", which walks the active release's own previousReleaseId.
    const res = await ROLLBACK(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releaseId).toBe('rel-A');
    // The exact version bytes staging originally recorded for rel-A, not a
    // regenerated or defaulted one — this is what "delete last good state"
    // would corrupt or lose.
    expect(body.version).toBe('1.0.0');

    const after = await ACTIVATION_GET(req());
    const afterBody = await after.json();
    expect(afterBody.active.releaseId).toBe('rel-A');
    expect(afterBody.active.version).toBe('1.0.0');

    // rel-B is not erased — it is on file as rolled_back, the audit trail a
    // real rollback leaves.
    expect(
      afterBody.history.some((r) => r.releaseId === 'rel-B' && r.status === 'rolled_back')
    ).toBe(true);

    // State this rollback has no business touching is untouched.
    expect(store.get('admin.drain:conn-1')).toBe(drainBefore);
  });

  it('update.rollback.exit: refuses to report success when nothing verified-good is on file to restore (report success after failed health)', async () => {
    // A fresh instance: no activation has ever happened, so there is no
    // previousReleaseId to walk back to.
    const before = snapshot();
    const res = await ROLLBACK(req());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_prior_release');
    expect(snapshot()).toBe(before);
  });

  it('update.rollback.exit: refuses a rollback target that was never staged, rather than reporting success (delete last good state)', async () => {
    seedPriorApplication();
    const before = snapshot();
    const res = await ROLLBACK(req({ toReleaseId: 'rel-deleted' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('not_found');
    expect(snapshot()).toBe(before);
  });
});
