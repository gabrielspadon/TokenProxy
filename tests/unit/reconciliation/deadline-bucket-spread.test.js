import { describe, it, expect } from 'vitest';
import {
  rankAccounts,
  deadlineBucket,
  DEADLINE_BUCKETS_PER_HORIZON,
} from '@/shared/utils/quotaRanking.js';

// Measured defect (live fleet, 6h window read read-only from
// ~/.tokenproxy/db/data.sqlite): one Claude seat took 1125 of 1659 requests
// (67.8%) while ten of fourteen seats sat weekly-depleted. The cause is not the
// load key being wrong, it is the load key never running: `quotaWindows` held
// 15 weekly (7d) rows across 15 connections with 15 DISTINCT resetAt values,
// staircased by minutes because each account's period began when it first
// served. compareHorizons compared those as exact milliseconds, so the
// reset-horizon key was decisive on every pair and the sort returned two keys
// before `byLoad`. These cases pin the fix: a deadline is compared at 1/24th of
// its own horizon, so near-equal resets TIE and fall through to load, while a
// materially sooner deadline still wins outright.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const weekly = (id, resetOffsetMs, { remaining = 500, limit = 1000 } = {}) => ({
  id,
  windows: [
    {
      scope: 'weekly (7d)',
      remaining,
      limit,
      resetAt: iso(resetOffsetMs),
      observedAt: iso(0),
      confidence: 'fresh',
    },
  ],
});

const load = (entries) =>
  new Map(Object.entries(entries).map(([id, pins]) => [id, { pins, inFlight: 0 }]));
const win = (result) => result.trace.find((e) => e.cls === 'SEL' && e.verdict === 'win');

describe('deadlineBucket: resolution follows the horizon', () => {
  it('buckets a deadline at 1/24th of its own horizon', () => {
    expect(DEADLINE_BUCKETS_PER_HORIZON).toBe(24);
    const weekBucketMs = (7 * DAY) / 24;
    expect(deadlineBucket(NOW, 7 * DAY)).toBe(Math.floor(NOW / weekBucketMs));
    // Two resets an hour apart on a 7d horizon land in ONE bucket.
    expect(deadlineBucket(NOW, 7 * DAY)).toBe(deadlineBucket(NOW + HOUR, 7 * DAY));
    // A day apart does not.
    expect(deadlineBucket(NOW, 7 * DAY)).not.toBe(deadlineBucket(NOW + DAY, 7 * DAY));
  });

  it('leaves an unknown horizon at full millisecond resolution', () => {
    expect(deadlineBucket(NOW, 1)).toBe(NOW);
    expect(deadlineBucket(Infinity, 7 * DAY)).toBe(Infinity);
  });
});

// THE INVARIANT. N eligible accounts with comparable headroom and staircased
// resets: M consecutive NEW placements distribute across them rather than
// returning the leader M times. This is the case that fails on the unbucketed
// comparator, which returns 'aaaaaaaa-1' all eight times.
describe('rankAccounts: staircased resets still spread (the live defect)', () => {
  // Three seats whose weekly windows reset 60 and 120 minutes apart, which is
  // the exact shape the live DB holds.
  const cohort = () => [
    weekly('aaaaaaaa-1', 7 * DAY),
    weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000),
    weekly('cccccccc-3', 7 * DAY + 120 * 60_000),
  ];

  it('M consecutive placements distribute across N comparable seats', () => {
    const pins = { 'aaaaaaaa-1': 0, 'bbbbbbbb-2': 0, 'cccccccc-3': 0 };
    const picks = [];
    for (let i = 0; i < 9; i += 1) {
      const res = rankAccounts(cohort(), {
        now: NOW,
        previousPinId: null,
        activeLoad: load(pins),
      });
      picks.push(res.winner.id);
      pins[res.winner.id] += 1;
    }
    // Every seat carried real traffic, and no seat carried the whole run.
    expect(new Set(picks).size).toBe(3);
    expect(Object.values(pins)).toEqual([3, 3, 3]);
  });

  // Two seats, so the runner-up the trace compares against IS the loaded one.
  // (With three, the two idle seats tie each other down to `fallback-order`
  // and the printed key describes that pair rather than the load decision.)
  it('the deciding key is load-spread, not reset-horizon', () => {
    const res = rankAccounts(
      [weekly('aaaaaaaa-1', 7 * DAY), weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000)],
      {
        now: NOW,
        previousPinId: null,
        activeLoad: load({ 'aaaaaaaa-1': 4 }),
      }
    );
    expect(win(res).fields.key).toBe('load-spread');
    expect(res.winner.id).toBe('bbbbbbbb-2');
  });
});

// PRESERVED BEHAVIOUR. The change widens a tie; it does not replace quota
// awareness, and it does not relax eligibility.
describe('rankAccounts: quota awareness survives the bucketing', () => {
  it('a materially sooner deadline still wins outright over a loaded-but-later seat', () => {
    // 2d against 6d is four buckets apart on a 7d horizon, so the deadline key
    // stays decisive and the idle account does NOT win on load.
    const res = rankAccounts([weekly('aaaaaaaa-1', 6 * DAY), weekly('bbbbbbbb-2', 2 * DAY)], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'bbbbbbbb-2': 5 }),
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(win(res).fields.key).toBe('reset-horizon');
  });

  it('a depleted seat stays ineligible however light its load', () => {
    const drained = weekly('aaaaaaaa-1', 7 * DAY, { remaining: 0 });
    const res = rankAccounts([drained, weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000)], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'bbbbbbbb-2': 7 }),
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(res.ineligible.map((r) => r.id)).toEqual(['aaaaaaaa-1']);
  });

  it('a seat under the headroom floor is still skipped for a loaded one above it', () => {
    // Headroom is ordered BEFORE load, so bucketing cannot promote a nearly
    // empty seat just because it is idle.
    const nearlyEmpty = weekly('aaaaaaaa-1', 7 * DAY, { remaining: 10, limit: 1000 });
    const res = rankAccounts([nearlyEmpty, weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000)], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'bbbbbbbb-2': 6 }),
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(win(res).fields.key).toBe('headroom');
  });

  it('an established healthy pin never moves for the spread', () => {
    const res = rankAccounts(
      [weekly('aaaaaaaa-1', 7 * DAY), weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000)],
      { now: NOW, previousPinId: 'aaaaaaaa-1', activeLoad: load({ 'aaaaaaaa-1': 9 }) }
    );
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('pinned-continuity');
  });

  it('ranking stays a total order under the bucketed key', () => {
    const cohort = [
      weekly('aaaaaaaa-1', 7 * DAY),
      weekly('bbbbbbbb-2', 7 * DAY + 60 * 60_000),
      weekly('cccccccc-3', 7 * DAY + 120 * 60_000),
    ];
    const once = rankAccounts(cohort, { now: NOW }).ranked.map((r) => r.id);
    for (let i = 0; i < 5; i += 1) {
      expect(rankAccounts(cohort, { now: NOW }).ranked.map((r) => r.id)).toEqual(once);
    }
  });
});
