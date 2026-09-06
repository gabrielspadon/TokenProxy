import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ operator: true, inference: false, loopback: true }));
vi.mock('@/dashboardGuard', () => ({
  hasValidCliToken: async () => auth.operator,
  isLocalRequest: () => auth.loopback,
}));
vi.mock('@/lib/auth/dashboardSession', () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock('@/lib/auth/clientApiKey', () => ({
  resolveClientApiKey: async () => ({ valid: auth.inference }),
}));
vi.mock('@/lib/admin/authzLog.js', () => ({ logAdminAuthz: vi.fn() }));

import { GET } from '@/app/api/admin/session-pins/[[...path]]/route.js';
import { getAdapter } from '@/lib/db/driver.js';
import { initDb } from '@/lib/db/index.js';
import { encodePinId } from '@/lib/db/repos/sessionPinsRepo.js';
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  parseSessionPinTimelineQuery,
  readSessionPinTimeline,
  validateSessionPinTimelineQuery,
  PIN_TIMELINE_MAX_PAGE,
} from '@/lib/db/analytics/sessionPinTimelineQueries.mjs';

const hash = 'd'.repeat(64);
const model = 'claude-fable-5';
const pinId = encodePinId({ sessionHash: hash, model });
const base = Date.parse('2026-09-06T00:00:00.000Z');
const at = (minutes) => new Date(base + minutes * 60_000).toISOString();
let db, sessionId;

async function timeline(query = `?pinId=${pinId}`) {
  const request = new Request(`http://localhost/api/admin/session-pins/timeline${query}`);
  const response = await GET(request, { params: Promise.resolve({ path: ['timeline'] }) });
  return { status: response.status, body: await response.json() };
}
const read = (params) =>
  readSessionPinTimeline(
    db,
    parseSessionPinTimelineQuery(new URLSearchParams({ sessionHash: hash, model, ...params }))
  );

beforeAll(async () => {
  await initDb();
  db = await getAdapter();
});

beforeEach(() => {
  for (const table of [
    'sessionAffinity',
    'sessionPinActions',
    'accountSwitches',
    'requestStats',
    'contextSessions',
  ])
    db.run(`DELETE FROM ${table}`);
  db.run(
    "INSERT INTO contextSessions(sessionHash, identitySource, firstSeenAt, lastSeenAt) VALUES(?,'explicit',?,?)",
    [hash, at(0), at(100)]
  );
  sessionId = db.get('SELECT id FROM contextSessions WHERE sessionHash=?', [hash]).id;
  db.run(
    'INSERT INTO sessionAffinity(sessionHash, model, connectionId, pinnedAt, lastSeenAt) VALUES(?,?,?,?,?)',
    [hash, model, 'account-a', at(0), at(100)]
  );
});

// Interleaved on purpose: each source owns a distinct minute so one correct
// merge order exists and a per-source sort would visibly disagree with it.
function seedMerged() {
  const rows = [];
  for (const [minute, kind] of [
    [10, 'request'],
    [20, 'switch'],
    [30, 'action'],
    [40, 'request'],
    [50, 'switch'],
    [60, 'action'],
  ]) {
    if (kind === 'request')
      db.run(
        `INSERT INTO requestStats(id, timestamp, model, requestedModel, connectionId, status,
           contextSessionId, logicalRequestId) VALUES(?,?,?,?,?,?,?,?)`,
        [
          `req-${minute}`,
          at(minute),
          model,
          'claude-latest',
          'account-a',
          'success',
          sessionId,
          `logical-${minute}`,
        ]
      );
    if (kind === 'switch')
      db.run(
        `INSERT INTO accountSwitches(id, sessionHash, model, fromConnectionId, toConnectionId,
           "trigger", reason, switchedAt) VALUES(?,?,?,?,?,?,?,?)`,
        [`sw-${minute}`, hash, model, 'account-a', 'account-b', 'exhaustion', 'quota', at(minute)]
      );
    if (kind === 'action')
      db.run(
        `INSERT INTO sessionPinActions(id, version, sessionHash, model, action, expectedRevision,
           expectedBinding, status, beforeState, preview, createdAt, previewExpiresAt)
         VALUES(?,1,?,?,'clear',?,?,'applied','{}','{}',?,?)`,
        [`act-${minute}`, hash, model, 'r'.repeat(64), 'b'.repeat(64), at(minute), at(minute + 5)]
      );
    rows.push({ minute, kind });
  }
  return rows;
}

function seedRequests(count) {
  for (let i = 0; i < count; i++)
    db.run(
      `INSERT INTO requestStats(id, timestamp, model, requestedModel, connectionId, status,
         contextSessionId) VALUES(?,?,?,?,?,?,?)`,
      [
        `bulk-${String(i).padStart(3, '0')}`,
        at(i),
        model,
        'claude-latest',
        i % 2 ? 'account-b' : 'account-a',
        'success',
        sessionId,
      ]
    );
}

it('merges the three sources into one descending time order with exact ids and a time basis', () => {
  seedMerged();
  const page = read({});
  expect(page.items.map((item) => `${item.kind}@${item.at}`)).toEqual([
    `action@${at(60)}`,
    `switch@${at(50)}`,
    `request@${at(40)}`,
    `action@${at(30)}`,
    `switch@${at(20)}`,
    `request@${at(10)}`,
  ]);
  expect(page.items[0]).toMatchObject({
    actionId: 'act-60',
    action: 'clear',
    timeBasis: 'createdAt',
  });
  expect(page.items[1]).toMatchObject({
    switchId: 'sw-50',
    fromConnectionId: 'account-a',
    toConnectionId: 'account-b',
    timeBasis: 'switchedAt',
  });
  expect(page.items[2]).toMatchObject({
    requestId: 'req-40',
    logicalRequestId: 'logical-40',
    connectionId: 'account-a',
    servedModel: model,
    timeBasis: 'timestamp',
  });
  expect(page.timeBasis).toEqual({
    request: 'requestStats.timestamp',
    switch: 'accountSwitches.switchedAt',
    action: 'sessionPinActions.createdAt',
  });
  expect(page.total).toBe(6);
});

it('pages beyond page one without repeating or dropping an entry', () => {
  seedRequests(30);
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 10; guard++) {
    const page = read({ pageSize: '7', ...(cursor ? { cursor } : {}) });
    expect(page.total).toBe(30);
    expect(page.pageSize).toBe(7);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.next;
    if (!cursor) break;
  }
  expect(seen).toHaveLength(30);
  expect(new Set(seen).size).toBe(30);
  // Descending by recorded time, so the newest bulk row comes first.
  expect(seen[0]).toBe('bulk-029');
  expect(seen.at(-1)).toBe('bulk-000');
});

it('keeps a filtered set stable across the cursor rather than filtering after the cut', () => {
  seedRequests(20);
  const first = read({ connectionId: 'account-b', pageSize: '4' });
  expect(first.total).toBe(10);
  expect(first.items.every((item) => item.connectionId === 'account-b')).toBe(true);
  const second = read({ connectionId: 'account-b', pageSize: '4', cursor: first.next });
  expect(second.total).toBe(10);
  expect(second.items.every((item) => item.connectionId === 'account-b')).toBe(true);
  const overlap = first.items.filter((item) => second.items.some((row) => row.id === item.id));
  expect(overlap).toEqual([]);
  // The same cursor re-read returns the same page: pagination is not a moving
  // window over a re-filtered set.
  expect(read({ connectionId: 'account-b', pageSize: '4', cursor: first.next }).items).toEqual(
    second.items
  );
});

it('a kind filter narrows before the cursor and never leaks another source in', () => {
  seedMerged();
  const page = read({ kind: 'switch', pageSize: '1' });
  expect(page.total).toBe(2);
  expect(page.items).toHaveLength(1);
  expect(page.items[0].kind).toBe('switch');
  const next = read({ kind: 'switch', pageSize: '1', cursor: page.next });
  expect(next.items[0]).toMatchObject({ kind: 'switch', switchId: 'sw-20' });
  expect(next.next).toBeNull();
});

it('renders an unjoinable source as unavailable rather than as an empty history', () => {
  seedMerged();
  db.run('DELETE FROM contextSessions');
  const page = read({});
  expect(page.sources.request).toMatchObject({
    available: false,
    reason: 'no-retained-session-join',
    identitySource: null,
  });
  expect(page.items.some((item) => item.kind === 'request')).toBe(false);
  // Switches and receipts join on the hash directly, so they survive.
  expect(page.items.map((item) => item.kind)).toEqual(['action', 'switch', 'action', 'switch']);
});

it('never claims a served model for a request that did not record success', () => {
  db.run(
    `INSERT INTO requestStats(id, timestamp, model, requestedModel, connectionId, status,
       contextSessionId) VALUES(?,?,?,?,?,?,?)`,
    ['req-fail', at(5), model, 'claude-latest', 'account-a', 'error', sessionId]
  );
  expect(read({}).items[0]).toMatchObject({
    status: 'error',
    selectedModel: model,
    servedModel: null,
  });
});

it('refuses a duplicate, unknown or malformed parameter and a forged cursor', async () => {
  for (const query of [
    `?pinId=${pinId}&pinId=${pinId}`,
    `?pinId=${pinId}&kind=request&kind=switch`,
    `?pinId=${pinId}&sessionHash=${hash}`,
    `?pinId=${pinId}&model=${model}`,
    `?pinId=${pinId}&limit=5`,
    `?pinId=${pinId}&kind=unknown`,
    `?pinId=${pinId}&pageSize=0`,
    `?pinId=${pinId}&pageSize=${PIN_TIMELINE_MAX_PAGE + 1}`,
    `?pinId=${pinId}&start=2026-09-06T00:00:00`,
    `?pinId=${pinId}&cursor=not-a-cursor`,
    '?pinId=not-a-pin',
    '',
  ]) {
    const response = await timeline(query);
    expect(response.status, `accepted ${query || '(no pinId)'}`).toBe(400);
  }
});

it('serves the timeline over the admin route and refuses a non-operator', async () => {
  seedMerged();
  const ok = await timeline(`?pinId=${pinId}&pageSize=2`);
  expect(ok.status).toBe(200);
  expect(ok.body.items).toHaveLength(2);
  expect(ok.body.total).toBe(6);
  expect(ok.body.next).toBeTruthy();
  auth.operator = false;
  expect((await timeline(`?pinId=${pinId}`)).status).toBe(401);
  auth.operator = true;
});

it('round-trips a cursor and refuses one that re-encodes differently', () => {
  const cursor = encodeTimelineCursor({ at: at(10), kind: 'request', id: 'req-10' });
  expect(decodeTimelineCursor(cursor)).toEqual({ at: at(10), kind: 'request', id: 'req-10' });
  const forged = Buffer.from(JSON.stringify([at(10), 'request', 'req-10', 'extra'])).toString(
    'base64url'
  );
  expect(() => decodeTimelineCursor(forged)).toThrow();
  expect(() => decodeTimelineCursor(Buffer.from('[]').toString('base64url'))).toThrow();
});

it('validates the worker-side operation the same way the route parses it', () => {
  expect(() => validateSessionPinTimelineQuery({ operation: 'session-pin-timeline' })).toThrow();
  expect(() =>
    validateSessionPinTimelineQuery({ operation: 'other', sessionHash: hash, model })
  ).toThrow();
  expect(() =>
    validateSessionPinTimelineQuery({
      operation: 'session-pin-timeline',
      sessionHash: hash,
      model,
      rogue: 1,
    })
  ).toThrow();
  const valid = validateSessionPinTimelineQuery({
    operation: 'session-pin-timeline',
    sessionHash: hash,
    model,
    pageSize: 10,
  });
  expect(valid).toMatchObject({
    operation: 'session-pin-timeline',
    sessionHash: hash,
    pageSize: 10,
  });
});

afterAll(async () => {
  await globalThis._contextAnalytics?.client.close();
});
