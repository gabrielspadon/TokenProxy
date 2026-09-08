import { describe, expect, it, vi } from 'vitest';

// Decision-trace contract for rankAccounts (docs/logging-design.md step 3.2,
// rows 18-24): the ranker stays pure and RETURNS {cls, verdict, fields}
// entries; auth.js prints them. These assert the trace's field shapes for the
// ordered path and every gate, and that nothing here prints.
import { rankAccounts } from '@/shared/utils/quotaRanking.js';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const w = (scope, remaining, limit, resetAt, { confidence = 'fresh', observedAt = iso(0) } = {}) => ({
  scope,
  remaining,
  limit,
  resetAt,
  observedAt,
  confidence,
});

const loaded = (id, windows, extra = {}) => ({ id, priority: 0, windows, ...extra });

// Two fresh 5h windows; `a` resets sooner so it carries expiring entitlement.
const freshA = () => loaded('conn_aaaaaaaa', [w('session (5h)', 100, 1000, iso(1 * HOUR))]);
const freshB = () => loaded('conn_bbbbbbbb', [w('session (5h)', 100, 1000, iso(2 * HOUR))]);

describe('rankAccounts trace: the ordered path', () => {
  it('names the ordering key that decided (reset-horizon) with winner fields', () => {
    const result = rankAccounts([freshA(), freshB()], { now: NOW });
    expect(result.trace).toHaveLength(1);
    const [entry] = result.trace;
    expect(entry.cls).toBe('SEL');
    expect(entry.verdict).toBe('win');
    expect(entry.fields).toMatchObject({
      conn: 'conn_aaa',
      key: 'reset-horizon',
      win: true,
      rem: 100,
      reset: iso(1 * HOUR),
    });
    // The runner-up is named with its evidence band, max 3.
    expect(entry.fields.alt).toEqual(['conn_bbb:fresh']);
  });

  it('folds stale evidence age into alt tokens (band:age)', () => {
    const stale = loaded('conn_bbbbbbbb', [
      w('session (5h)', 100, 1000, iso(2 * HOUR), { confidence: 'stale', observedAt: iso(-2 * HOUR) }),
    ]);
    const result = rankAccounts([freshA(), stale], { now: NOW });
    expect(result.trace[0].fields.key).toBe('evidence-band');
    expect(result.trace[0].fields.alt).toEqual(['conn_bbb:stale:2h']);
  });

  it('reports pinned-continuity when the previous pin decides between equals', () => {
    // Identical evidence on both: only the pin separates them.
    const twinA = () => loaded('conn_aaaaaaaa', [w('session (5h)', 100, 1000, iso(2 * HOUR))]);
    const result = rankAccounts([twinA(), freshB()], { now: NOW, previousPinId: 'conn_bbbbbbbb' });
    expect(result.trace[0].fields.conn).toBe('conn_bbb');
    expect(result.trace[0].fields.key).toBe('pinned-continuity');
  });

  it('reports configured-priority when priority breaks the tie', () => {
    const a = loaded('conn_aaaaaaaa', [w('session (5h)', 100, 1000, iso(1 * HOUR))], { priority: 2 });
    const b = loaded('conn_bbbbbbbb', [w('session (5h)', 100, 1000, iso(1 * HOUR))], { priority: 1 });
    const result = rankAccounts([a, b], { now: NOW });
    expect(result.trace[0].fields.conn).toBe('conn_bbb');
    expect(result.trace[0].fields.key).toBe('configured-priority');
  });

  it('reports fallback-order for a singleton cohort and omits unknown fields', () => {
    const result = rankAccounts([freshA()], { now: NOW });
    expect(result.trace[0].fields).toMatchObject({ conn: 'conn_aaa', key: 'fallback-order', win: true });
    expect(result.trace[0].fields.alt).toEqual([]);
  });

  it('never prints: the ranker is pure', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      rankAccounts([freshA(), freshB()], { now: NOW });
      rankAccounts([], { now: NOW });
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('rankAccounts trace: the gates', () => {
  // `invalid-record` is a REPORT, not a gate. Since the per-account ranking
  // landed (b09a9277) an account whose windows cannot be read is ranked last
  // and still served, because refusing to rank is not evidence of unusability.
  // So the entry names the offender and the reason, and the ordering verdict
  // still follows it.
  it('invalid-record names the offending id and the reason, and still serves it', () => {
    const result = rankAccounts([loaded('conn_deadbeef', 'not-windows')], { now: NOW });
    expect(result.trace[0]).toEqual({
      cls: 'RANK',
      verdict: 'invalid-record',
      fields: { conn: 'conn_dea', why: 'no-windows' },
    });
    expect(result.trace.at(-1).verdict).toBe('win');
    expect(result.winner?.id).toBe('conn_deadbeef');
  });

  it('invalid-record fires for a malformed window inside a cohort', () => {
    const bad = loaded('conn_badbad01', [{ scope: 'session (5h)', remaining: 'x', limit: 1, resetAt: iso(HOUR) }]);
    const result = rankAccounts([freshA(), bad], { now: NOW });
    expect(result.trace[0].verdict).toBe('invalid-record');
    expect(result.trace[0].fields.conn).toBe('conn_bad');
    expect(result.trace[0].fields.why).toBe('bad-remaining:session (5h)');
  });

  // The cohort shape gate is GONE (b09a9277). A pool whose accounts report
  // different window sets is the normal case on live Claude connections — plan
  // tier and recent usage both change which windows a provider bothers to
  // report — and refusing to rank it fired on roughly a third of real
  // switches while still offering provably-depleted accounts in `ranked`.
  // Each account is now ranked on its own binding deadline instead, so a mixed
  // cohort produces an ordinary win, never a `shape-mismatch` refusal.
  it('a mixed-shape cohort ranks on each account own deadline, not a shape refusal', () => {
    const b = loaded('conn_bbbbbbbb', [w('weekly (7d)', 100, 1000, iso(2 * DAY))]);
    const result = rankAccounts([freshA(), b], { now: NOW });
    expect(result.degraded).toBe(false);
    expect(result.trace.map((e) => e.verdict)).not.toContain('shape-mismatch');
    const [entry] = result.trace;
    expect(entry.verdict).toBe('win');
    expect(entry.fields.win).toBe(true);
    // A known weekly deadline precedes missing weekly evidence.
    expect(entry.fields.conn).toBe('conn_bbb');
    expect(entry.fields.key).toBe('reset-horizon');
  });

  it('depleted names every account, its band, and the soonest reset', () => {
    const a = loaded('conn_aaaaaaaa', [w('session (5h)', 0, 1000, iso(2 * HOUR))]);
    const b = loaded('conn_bbbbbbbb', [
      w('session (5h)', 0, 1000, iso(1 * HOUR), { confidence: 'unknown', observedAt: null }),
    ]);
    const result = rankAccounts([a, b], { now: NOW });
    const [entry] = result.trace;
    expect(entry.verdict).toBe('depleted');
    expect(entry.fields.win).toBe(false);
    expect(entry.fields.alt).toEqual(['conn_aaa:fresh', 'conn_bbb:unknown']);
    expect(entry.fields.reset).toBe(iso(1 * HOUR));
  });

  it('empty cohort degrades with the reason, not a fake winner', () => {
    const result = rankAccounts([], { now: NOW });
    expect(result.trace).toEqual([
      { cls: 'RANK', verdict: 'degraded', fields: { win: false, why: 'empty-cohort' } },
    ]);
  });
});

// Isolate decision semantics from the separately qualified asynchronous transport.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
