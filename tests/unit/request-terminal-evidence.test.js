import { beforeAll, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { REQUEST_TERMINAL_COLUMNS, normalizeTerminalEvidence } from '../../src/lib/db/terminalEvidence.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';

let db;
beforeAll(async () => {
  db = await getAdapter();
  // Schema registration belongs to the release lead; test the additive shape.
  const columns = new Set(db.all('PRAGMA table_info(requestStats)').map((row) => row.name));
  for (const [column, definition] of Object.entries(REQUEST_TERMINAL_COLUMNS)) {
    if (!columns.has(column)) db.run(`ALTER TABLE requestStats ADD COLUMN ${column} ${definition}`);
  }
});

it('persists allowlisted terminal evidence with its outcome and resists late pending writes', async () => {
  await saveRequestStats({ id: 'evidence-fixture', status: 'error', terminalEvidence: {
    state: 'failed', source: 'provider-stream', reason: 'upstream-error-event', payload: 'secret-canary',
  } });
  const row = db.get('SELECT status,terminalState,terminalReason,terminalSource,terminalObservedAt FROM requestStats WHERE id=?', ['evidence-fixture']);
  expect(row).toMatchObject({ status: 'error', terminalState: 'failed', terminalSource: 'provider-stream', terminalReason: 'upstream-error-event' });
  expect(Date.parse(row.terminalObservedAt)).toBeGreaterThan(0);
  await saveRequestStats({ id: 'evidence-fixture', status: 'pending' });
  expect(db.get('SELECT status FROM requestStats WHERE id=?', ['evidence-fixture']).status).toBe('error');
  expect(JSON.stringify(row)).not.toContain('secret-canary');
});

it('rejects mismatched status or unbounded reasons before writing statistics', async () => {
  expect(() => normalizeTerminalEvidence({ state: 'failed', source: 'provider-stream', reason: 'secret-canary' }, 'error')).toThrow('Invalid terminal evidence');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await saveRequestStats({ id: 'mismatched-fixture', status: 'success', terminalEvidence: {
      state: 'failed', source: 'provider-stream', reason: 'upstream-error-event',
    } });
    expect(db.get('SELECT id FROM requestStats WHERE id=?', ['mismatched-fixture'])).toBeUndefined();
  } finally { spy.mockRestore(); }
});
