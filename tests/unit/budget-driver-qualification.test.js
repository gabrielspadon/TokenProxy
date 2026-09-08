import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSqlJsAdapter } from '@/lib/db/adapters/sqljsAdapter.js';
import { createBetterSqliteAdapter } from '@/lib/db/adapters/betterSqliteAdapter.js';
import { runMigrationOnce } from '@/lib/db/migrate.js';

// The fallback chain is exercised with the REAL adapters here. Renaming a native
// adapter's driver string proves only that the string is read; this file proves
// what sql.js and better-sqlite3 actually do across reopen and a failed write.
const state = vi.hoisted(() => ({ db: null }));
vi.mock('@/lib/db/driver.js', () => ({ getAdapter: async () => state.db }));
const { createApiKey, updateApiKey } = await import('@/lib/db/repos/apiKeysRepo.js');
const { saveRequestUsage } = await import('@/lib/db/repos/usageRepo.js');
const { reserveBudget, markBudgetDispatched, getBudgetStatus, getApiKeyBudgetSummaries } = await import('@/lib/db/repos/budgetRepo.js');

let dir, file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-budget-driver-')); file = path.join(dir, 'data.sqlite'); });
afterEach(() => { vi.restoreAllMocks(); try { state.db?.close(); } catch {} state.db = null; fs.rmSync(dir, { recursive: true, force: true }); });
const open = async (driver) => { state.db = await (driver === 'sql.js' ? createSqlJsAdapter(file) : createBetterSqliteAdapter(file)); await runMigrationOnce(state.db); return state.db; };
const reopen = async (driver) => { state.db.flush?.(); state.db.close(); state.db = null; return open(driver); };
async function cappedKey() { const c = await createApiKey('driver fixture', 'isolated'); return updateApiKey(c.id, { maxCompletionTokens: 100, budgetPolicy: 'reserve-remaining' }); }

describe.each(['better-sqlite3', 'sql.js'])('accounting on %s', (driver) => {
  it('preserves recorded usage and counters after reopening the same file', async () => {
    await open(driver);
    const k = await cappedKey();
    await saveRequestUsage({ apiKey: k.key, provider: 'test', model: 'test', requestId: randomUUID(), tokens: { prompt_tokens: 8, completion_tokens: 6 } });
    const before = await getBudgetStatus(k.id);
    expect(before.account).toMatchObject({ recordedPromptTokens: 8, recordedCompletionTokens: 6 });
    await reopen(driver);
    const after = await getBudgetStatus(k.id);
    expect(after.account).toMatchObject({ recordedPromptTokens: 8, recordedCompletionTokens: 6 });
    expect(state.db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
    expect((await getApiKeyBudgetSummaries())[k.id].durableStorage).toBe(driver !== 'sql.js');
  });
});

describe('sql.js', () => {
  it('cannot admit capped dispatch and writes nothing, while an unlimited key keeps its fast path', async () => {
    await open('sql.js');
    const k = await cappedKey();
    const unlimited = await createApiKey('uncapped', 'isolated');
    await expect(reserveBudget({ apiKey: k.key, requestId: randomUUID(), logicalRequestId: 'l' })).rejects.toMatchObject({ code: 'durable-storage-required' });
    expect(await reserveBudget({ apiKey: unlimited.key, requestId: randomUUID(), logicalRequestId: 'l' })).toBeNull();
    await reopen('sql.js');
    expect(state.db.get('SELECT COUNT(*) AS n FROM apiKeyBudgetReservations').n).toBe(0);
  });
  it('surfaces a failed publication instead of reporting the write as durable', async () => {
    await open('sql.js');
    const k = await cappedKey();
    await saveRequestUsage({ apiKey: k.key, provider: 'test', model: 'test', requestId: randomUUID(), tokens: { prompt_tokens: 8, completion_tokens: 6 } });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EIO: publication failed'), { code: 'EIO' }); });
    expect(() => state.db.flush()).toThrow('publication failed');
    rename.mockRestore();
    // The in-memory state is intact and a later flush lands the same rows.
    expect(state.db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
    await reopen('sql.js');
    expect(state.db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(1);
  });
});

describe('better-sqlite3', () => {
  it('keeps uncertain exposure when usage recording fails after dispatch', async () => {
    await open('better-sqlite3');
    const k = await cappedKey();
    const r = await reserveBudget({ apiKey: k.key, requestId: randomUUID(), logicalRequestId: 'l' });
    await markBudgetDispatched(r.requestId);
    const run = state.db.run.bind(state.db);
    const spy = vi.spyOn(state.db, 'run').mockImplementation((sql, args) => { if (/INSERT INTO usageHistory/.test(sql)) throw new Error('disk full'); return run(sql, args); });
    await saveRequestUsage({ apiKey: k.key, provider: 'test', model: 'test', requestId: r.requestId, logicalRequestId: 'l', tokens: { prompt_tokens: 8, completion_tokens: 6 } });
    spy.mockRestore();
    const status = await getBudgetStatus(k.id);
    expect(status.reservations[0].state).toBe('dispatched');
    expect(status.outstanding.completionTokens).toBe(100);
    expect(state.db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(0);
    await reopen('better-sqlite3');
    expect((await getBudgetStatus(k.id)).outstanding.completionTokens).toBe(100);
  });
});
