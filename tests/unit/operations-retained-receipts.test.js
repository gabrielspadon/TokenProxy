import { afterAll, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import {
  readOperationEvents,
  parseOperationEventsQuery,
} from '@/lib/db/analytics/operationEventsQueries.mjs';
import { resolveOperationRows } from '@/shared/workspace/operationHistoryModel';
import { compatibilityStore } from '@/lib/db/repos/compatibilityRepo.js';
import { SAMPLE_FIXTURES } from '@/shared/compatibility/samples';
import { evidenceHref } from '@/shared/workspace/notificationRulesModel.js';

let db;
afterAll(() => db?.close());

it('matches a terminal receipt outside the page, state filter and capture range', async () => {
  db = await getAdapter();
  const insert = (state, capturedAt) =>
    db.run(
      'INSERT INTO operationEvents(operationId,phase,state,subjectKind,subjectId,source,actorClass,occurredAt,capturedAt,details) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        'synthetic-op',
        'reachability',
        state,
        'proxyPool',
        'synthetic-pool',
        'fixture',
        'operator',
        capturedAt,
        capturedAt,
        '{}',
      ]
    );
  insert('started', '2026-09-07T10:00:00.000Z');
  insert('succeeded', '2026-09-07T12:00:00.000Z');
  const result = readOperationEvents(
    db,
    parseOperationEventsQuery(
      new URLSearchParams({
        start: '2026-09-07T09:00:00Z',
        end: '2026-09-07T11:00:00Z',
        state: 'started',
        pageSize: '1',
      })
    )
  );
  expect(result.total).toBe(1);
  expect(result.items[0].terminalReceipt).toMatchObject({
    state: 'succeeded',
    capturedAt: '2026-09-07T12:00:00.000Z',
  });
  expect(resolveOperationRows(result.items)[0].unresolved).toBe(false);
});

it('queue counts include all fixtures while retained history is filtered and paged', async () => {
  db ||= await getAdapter();
  const store = compatibilityStore(db);
  const one = store.createFixture(SAMPLE_FIXTURES[0]);
  const two = store.createFixture(SAMPLE_FIXTURES[1]);
  store.createRun(one.id, 1, 'fixture-owner');
  const running = store.createRun(two.id, 1, 'fixture-owner');
  store.transition(running.run.id, 'running');
  const result = store.listRuns({ page: 1, pageSize: 1, fixtureId: one.id });
  expect(result.items).toHaveLength(1);
  expect(result.queue).toEqual({ queued: 1, running: 1, scope: 'installation-operator' });
  const evidence = store.evidence();
  expect(evidence.reduce((total, row) => total + row.other, 0)).toBe(0);
  expect(evidence.reduce((total, row) => total + row.pending, 0)).toBe(2);
});

it('opens an exact historical alert event without losing it beyond default pagination', async () => {
  db ||= await getAdapter();
  const inserted = db.run(`INSERT INTO operationEvents(operationId,phase,state,subjectKind,subjectId,source,actorClass,occurredAt,capturedAt,details)
    VALUES('old-operation','reachability','failed','proxyPool','old-pool','fixture','operator','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z','{}')`);
  const id = String(inserted.lastInsertRowid);
  const params = new URL(evidenceHref('operationEvent', id), 'http://localhost').searchParams;
  const selected = params.get('event'); params.delete('event');
  const result = readOperationEvents(db, parseOperationEventsQuery(params));
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({ id: Number(selected), operationId: 'old-operation' });
  expect(() => parseOperationEventsQuery(new URLSearchParams({ eventId: '1 OR 1=1' }))).toThrow(/eventId/);
});
