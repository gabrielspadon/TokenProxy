import { describe, expect, it } from 'vitest';
import { decideRepin, TRIGGERS } from '@/shared/utils/repinPolicy.js';
import { rankAccounts } from '@/shared/utils/quotaRanking.js';

// THE DEFECT, measured on live production 2026-09-11.
//
// 99.8% of selections short-circuit at the session pin (pin-hit 485, win 1 over
// one hour), so whatever the pin path decides is what production does. The
// release path itself was already correct: a pin on a seat with a read
// remaining=0 and eligible alternatives repins on `pinned-window-exhausted`,
// and the live switch log shows 52 such moves in 24h.
//
// What was NOT correct is the opposite case. An account whose quota read FAILED
// carries `windows: []`. resolveWindows reports it `usable: true`, because
// nothing depleted it — nothing was read at all. So it lands in `eligible`, the
// pin-healthy test matches, and the session is held on a seat we know nothing
// about for as long as it keeps talking. Connection 01d2af87 held 43 live pins
// with zero rows in quotaWindows, the oldest bound 186 hours, beside accounts
// with real read headroom.
//
// The fix requires POSITIVE evidence of headroom to hold a pin, rather than the
// absence of evidence of depletion.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// confidence 'unknown' throughout: every row in the live quotaWindows table
// reads unknown, so a test keyed on 'fresh' would assert against a band the
// production data never reaches.
const w = (scope, remaining, limit, resetOffsetMs) => ({
  scope,
  remaining,
  limit,
  resetAt: iso(resetOffsetMs),
  observedAt: iso(0),
  confidence: 'unknown',
});

const readable = (id, remaining, resetOffsetMs = 5 * 24 * HOUR) => ({
  id,
  windows: [w('weekly (7d)', remaining, 100, resetOffsetMs)],
});
// The shape a failed quota read produces: auth.js pushes the connection to
// quotaUnknown and hands the scheduler an empty window array.
const blind = (id) => ({ id, windows: [] });

describe('a pin is held on evidence of headroom, never on absence of evidence', () => {
  it('the ranker calls a seat with no windows usable, which is what made the pin immortal', () => {
    // Not a bug in the ranker: nothing read it, so nothing can prove it
    // depleted. The bug was the pin path treating that as health.
    const res = rankAccounts([blind('blind-1'), readable('read-1', 67)], { now: NOW });
    const record = res.ranked.find((r) => r.id === 'blind-1');
    expect(record.usable).toBe(true);
    expect(record.windows).toHaveLength(0);
    // The ranker already grades it last for a NEW pin. Only the pin path ignored that.
    expect(record.evidenceBand).toBe(2);
    expect(res.winner.id).toBe('read-1');
  });

  it('releases a pin whose account has no quota evidence when a readable one exists', () => {
    const d = decideRepin({
      pin: { connectionId: 'blind-1', pinnedAt: iso(-186 * HOUR) },
      accounts: [blind('blind-1'), readable('read-1', 67)],
      now: NOW,
    });
    expect(d).toMatchObject({
      action: 'repin',
      from: 'blind-1',
      connectionId: 'read-1',
      trigger: TRIGGERS.UNAVAILABLE,
      reason: 'pinned-evidence-absent:moving-to-readable',
    });
  });

  it('holds a blind pin when every alternative is equally blind', () => {
    // No better-evidenced seat exists, so moving buys nothing and costs a full
    // cache re-prime. This is also the degraded-pool shape, and it must not spray.
    const d = decideRepin({
      pin: { connectionId: 'blind-1', pinnedAt: iso(-186 * HOUR) },
      accounts: [blind('blind-1'), blind('blind-2')],
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('blind-1');
  });

  it('holds a blind pin when the only readable alternative is depleted', () => {
    // `eligible` is the source for the alternative, so a depleted seat is never
    // a repin target: a blind seat that might serve beats one that read zero.
    const d = decideRepin({
      pin: { connectionId: 'blind-1', pinnedAt: iso(-186 * HOUR) },
      accounts: [blind('blind-1'), readable('read-1', 0)],
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.connectionId).toBe('blind-1');
  });

  it('does not move a pin that has its own readable headroom', () => {
    // The anti-spray invariant this policy exists for. A seat with read evidence
    // keeps its session even when another seat reads better.
    const d = decideRepin({
      pin: { connectionId: 'read-1', pinnedAt: iso(-16 * HOUR) },
      accounts: [readable('read-1', 33), readable('read-2', 67)],
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('pin-healthy');
  });

  it('still holds the pin when the whole pool reads depleted', () => {
    // The all-depleted hold is untouched. There the pin IS ineligible, on
    // evidence we read and have reason to distrust (every live row is
    // confidence unknown, some observedAt stamps days old), so the upstream
    // decides rather than an aging snapshot.
    const d = decideRepin({
      pin: { connectionId: 'read-1', pinnedAt: iso(-10 * HOUR) },
      accounts: [readable('read-1', 0), readable('read-2', 0)],
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toMatch(/all-depleted/);
  });

  it('still holds the pin when no account anywhere carries a deadline', () => {
    // The degraded hold is untouched, and it is reached before this branch:
    // an all-blind pool degrades, and there is no readable alternative to move
    // to anyway. Both paths agree, which is what keeps them from fighting.
    const blindPool = [blind('blind-1'), blind('blind-2')];
    expect(rankAccounts(blindPool, { now: NOW }).degraded).toBe(true);
    const d = decideRepin({
      pin: { connectionId: 'blind-1', pinnedAt: iso(0) },
      accounts: blindPool,
      now: NOW,
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toMatch(/ranking-degraded/);
  });

  it('releases a depleted pin to a readable alternative, unchanged', () => {
    // The pre-existing release path, asserted here so a future edit to the
    // branch above cannot quietly take it with it.
    const d = decideRepin({
      pin: { connectionId: 'read-1', pinnedAt: iso(-10 * HOUR) },
      accounts: [readable('read-1', 0), readable('read-2', 67)],
      now: NOW,
    });
    expect(d).toMatchObject({
      action: 'repin',
      from: 'read-1',
      connectionId: 'read-2',
      trigger: TRIGGERS.EXHAUSTION,
      reason: 'pinned-window-exhausted',
    });
  });

  it('is stable across repeated decisions once the session has moved', () => {
    // The move must converge, not oscillate: after landing on the readable seat
    // the session stays there on unchanged evidence.
    const accounts = [blind('blind-1'), readable('read-1', 67)];
    const first = decideRepin({
      pin: { connectionId: 'blind-1', pinnedAt: iso(-186 * HOUR) },
      accounts,
      now: NOW,
    });
    expect(first.action).toBe('repin');
    for (let i = 0; i < 5; i += 1) {
      const next = decideRepin({
        pin: { connectionId: first.connectionId, pinnedAt: iso(0) },
        accounts,
        now: NOW + i * 60_000,
      });
      expect(next.action).toBe('keep');
      expect(next.connectionId).toBe('read-1');
    }
  });
});
