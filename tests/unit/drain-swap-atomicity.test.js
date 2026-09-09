import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Manual drain against automated remediation on the same account. The manual
// route reads its precondition, then writes; an automation transaction landing
// between the two must not be overwritten, and must not be double-counted.
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(async () => null), between: null }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({ getProviderConnectionById: vi.fn(async (id) => ({ id })) }));
vi.mock('@/lib/admin/state.js', async (original) => {
  const real = await original();
  return { ...real, readDrainDoc: async (id) => { const doc = await real.readDrainDoc(id); if (mocks.between) { const run = mocks.between; mocks.between = null; await run(); } return doc; } };
});
const { getAdapter } = await import('@/lib/db/driver.js');
const { readDrainDoc, swapDrainDoc, versionOf, writeDrainDoc } = await import('@/lib/admin/state.js');
const { POST, DELETE } = await import('@/app/api/admin/drain/[connectionId]/route.js');
const db = await getAdapter();
const post = (id, body) => POST(new Request(`http://localhost/api/admin/drain/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }), { params: Promise.resolve({ connectionId: id }) });
const del = (id, ifMatch) => DELETE(new Request(`http://localhost/api/admin/drain/${id}${ifMatch ? `?ifMatch=${ifMatch}` : ''}`, { method: 'DELETE' }), { params: Promise.resolve({ connectionId: id }) });
// What remediation.mjs writes inside its own transaction.
const automationDrain = (id, at = new Date().toISOString()) => db.run("INSERT INTO kv(scope,key,value) VALUES('admin.drain',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value", [id, JSON.stringify({ isDraining: true, requestedAt: at, completedAt: null })]);
let id;
beforeEach(() => { id = randomUUID(); mocks.between = null; db.run("DELETE FROM kv WHERE scope='admin.drain'"); });

describe('swapDrainDoc', () => {
  it('writes only against the exact document it was given', async () => {
    const next = { isDraining: true, requestedAt: '2026-09-08T00:00:00.000Z', completedAt: null };
    expect(await swapDrainDoc(id, null, next)).toEqual({ written: true, current: next });
    const stale = await swapDrainDoc(id, null, { isDraining: false, requestedAt: null, completedAt: 'x' });
    expect(stale.written).toBe(false);
    expect(versionOf(stale.current)).toBe(versionOf(next));
    expect(await readDrainDoc(id)).toEqual(next);
  });
});

describe('manual drain verbs against a concurrent automation write', () => {
  it('POST refuses with 412 when automation drained the account after the precondition read, and keeps the automation document', async () => {
    const at = '2026-09-08T01:02:03.000Z';
    mocks.between = () => automationDrain(id, at);
    const response = await post(id);
    expect(response.status).toBe(412);
    const body = await response.json();
    expect(body.code).toBe('version_conflict');
    const current = await readDrainDoc(id);
    expect(current).toEqual({ isDraining: true, requestedAt: at, completedAt: null });
    expect(body.currentVersion).toBe(versionOf(current));
  });
  it('DELETE refuses with 412 when the document changed after its read, so a fresh automation drain is not ended blindly', async () => {
    await writeDrainDoc(id, { isDraining: true, requestedAt: '2026-09-08T00:00:00.000Z', completedAt: null });
    const at = '2026-09-08T00:00:05.000Z';
    mocks.between = () => automationDrain(id, at);
    const response = await del(id);
    expect(response.status).toBe(412);
    expect(await readDrainDoc(id)).toEqual({ isDraining: true, requestedAt: at, completedAt: null });
  });
  it('an unraced POST then DELETE still round-trips with the ifMatch contract', async () => {
    const started = await post(id);
    expect(started.status).toBe(200);
    const state = await started.json();
    expect(state.isDraining).toBe(true);
    expect((await del(id, 'stale-version')).status).toBe(412);
    const ended = await del(id, state.version);
    expect(ended.status).toBe(200);
    expect((await readDrainDoc(id)).isDraining).toBe(false);
  });
});
