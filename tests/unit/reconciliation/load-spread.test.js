import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rankAccounts,
  HEADROOM_FLOOR_FRACTION,
  headroomFloorOf,
} from '@/shared/utils/quotaRanking.js';
import { selectAndReserve } from '@/sse/services/accountScheduler.js';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';
import { decideRepin } from '@/shared/utils/repinPolicy.js';

// Measured defect (production journal after the 10:10 ADT restart): 102 of 103
// REQ.ok on one connection. Per-agent affinity keys gave every agent its own
// pin, but the ranker is a function of quota evidence alone, so every fresh
// pin landed on the same best-evidenced account, drove it into its upstream
// rate limit, and the three accounts with headroom never got traffic and so
// never gained evidence. These cases pin the spread: NEW pins go by headroom
// floor, then by live pins plus open leases; EXISTING pins never move for it.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const w = (remaining, { confidence = 'fresh', resetOffsetMs = 2 * HOUR, limit = 1000 } = {}) => ({
  scope: 'session (5h)',
  remaining,
  limit,
  resetAt: iso(resetOffsetMs),
  observedAt: iso(0),
  confidence,
});

const fresh = (id, extra = {}) => ({ id, windows: [w(500, extra)] });
const unknown = (id, extra = {}) => ({
  id,
  windows: [w(500, { confidence: 'unknown', ...extra })],
});

const load = (entries) =>
  new Map(Object.entries(entries).map(([id, pins]) => [id, { pins, inFlight: 0 }]));
const win = (result) => result.trace.find((e) => e.cls === 'SEL' && e.verdict === 'win');

describe('rankAccounts: load spread for a NEW pin', () => {
  it('(a) two fresh accounts, one carrying 3 pins: the new pin goes to the empty one', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'aaaaaaaa-1': 3 }),
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(win(res).fields.key).toBe('load-spread');
    // The alt token carries the load the decision was made on.
    expect(win(res).fields.alt).toEqual(['aaaaaaaa:fresh:l3']);
  });

  it('(b) an existing pin stays on its account regardless of load', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: 'aaaaaaaa-1',
      activeLoad: load({ 'aaaaaaaa-1': 3 }),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('pinned-continuity');
  });

  it('(c) fresh quota evidence outranks an idle account with unknown evidence', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), unknown('cccccccc-3')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'aaaaaaaa-1': 1 }),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('evidence-band');
  });

  it('(c, existing pin) unknown never outranks fresh for a pinned session even when the pin is loaded', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), unknown('cccccccc-3')], {
      now: NOW,
      previousPinId: 'aaaaaaaa-1',
      activeLoad: load({ 'aaaaaaaa-1': 5 }),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('evidence-band');
  });

  it('(d) an idle fresh account beats an idle unknown one', () => {
    const res = rankAccounts([unknown('cccccccc-3'), fresh('aaaaaaaa-1')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({}),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('evidence-band');
  });

  it('(e) the trace names the deciding key and the vocabulary is closed', () => {
    const keys = new Set();
    keys.add(
      win(rankAccounts([fresh('a-1'), fresh('b-2')], { now: NOW, activeLoad: load({ 'a-1': 1 }) }))
        .fields.key
    );
    keys.add(
      win(
        rankAccounts([fresh('a-1'), unknown('c-3')], { now: NOW, activeLoad: load({ 'a-1': 1 }) })
      ).fields.key
    );
    keys.add(
      win(
        rankAccounts([{ id: 'a-1', windows: [w(10)] }, fresh('b-2')], {
          now: NOW,
          activeLoad: load({ 'b-2': 4 }),
        })
      ).fields.key
    );
    expect([...keys].sort()).toEqual(['evidence-band', 'headroom', 'load-spread']);
  });

  it('an alt with no load prints no load token, so a nominal line costs no extra bytes', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({}),
    });
    expect(win(res).fields.alt).toEqual(['bbbbbbbb:fresh']);
  });

  it('without activeLoad the comparator and the alt tokens are unchanged', () => {
    const res = rankAccounts([fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2', { resetOffsetMs: HOUR })], {
      now: NOW,
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(win(res).fields.key).toBe('reset-horizon');
    expect(win(res).fields.alt).toEqual(['aaaaaaaa:fresh']);
  });
});

describe('rankAccounts: headroom floor for a NEW pin', () => {
  it('exports a floor of 5% of the limit, never below one unit', () => {
    expect(HEADROOM_FLOOR_FRACTION).toBe(0.05);
    expect(headroomFloorOf(1000)).toBe(50);
    expect(headroomFloorOf(10)).toBe(1);
    expect(headroomFloorOf(null)).toBe(1);
  });

  it('a new pin skips an idle account under the floor for a loaded one above it', () => {
    const under = { id: 'aaaaaaaa-1', windows: [w(headroomFloorOf(1000) - 1)] };
    const res = rankAccounts([under, fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'bbbbbbbb-2': 4 }),
    });
    expect(res.winner.id).toBe('bbbbbbbb-2');
    expect(win(res).fields.key).toBe('headroom');
    // Under the floor is not ineligible: it is still rotation inventory.
    expect(res.eligible.map((r) => r.id)).toEqual(['bbbbbbbb-2', 'aaaaaaaa-1']);
  });

  it('exactly at the floor counts as headroom', () => {
    const at = { id: 'aaaaaaaa-1', windows: [w(headroomFloorOf(1000))] };
    const res = rankAccounts([at, fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: null,
      activeLoad: load({ 'bbbbbbbb-2': 1 }),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('load-spread');
  });

  it('an existing pin keeps serving from an account under the floor', () => {
    const under = { id: 'aaaaaaaa-1', windows: [w(headroomFloorOf(1000) - 1)] };
    const res = rankAccounts([under, fresh('bbbbbbbb-2')], {
      now: NOW,
      previousPinId: 'aaaaaaaa-1',
      activeLoad: load({}),
    });
    expect(res.winner.id).toBe('aaaaaaaa-1');
    expect(win(res).fields.key).toBe('pinned-continuity');
  });
});

describe('selectAndReserve: wires live pins and open leases into the spread', () => {
  const ungated = () => createLeaseRegistry({ capacityOf: () => 0 });
  const fakeRepos = ({ pin = null, pins = {} } = {}) => ({
    transaction: (fn) => fn(),
    getPin: () => pin,
    setPin: vi.fn(),
    touchPin: vi.fn(),
    countActivePins: vi.fn(() => pins),
    recordSwitch: (r) => r,
  });

  it('a new pin lands on the account with no live pins, and the count is read for this model', () => {
    const repos = fakeRepos({ pins: { 'aaaaaaaa-1': 3 } });
    const d = selectAndReserve({
      sessionHash: 'sha256:new',
      model: 'm',
      accounts: [fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')],
      now: NOW,
      registry: ungated(),
      repos,
    });
    expect(d.connection.id).toBe('bbbbbbbb-2');
    expect(repos.countActivePins).toHaveBeenCalledWith({ model: 'm', now: NOW });
    expect(d.trace.find((e) => e.verdict === 'win').fields.key).toBe('load-spread');
  });

  it('open leases count as load even when the repos cannot count pins', () => {
    const registry = ungated();
    registry.reserve('aaaaaaaa-1');
    registry.reserve('aaaaaaaa-1');
    const repos = fakeRepos();
    delete repos.countActivePins;
    const d = selectAndReserve({
      sessionHash: 'sha256:new',
      model: 'm',
      accounts: [fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')],
      now: NOW,
      registry,
      repos,
    });
    expect(d.connection.id).toBe('bbbbbbbb-2');
    expect(d.trace.find((e) => e.verdict === 'win').fields.alt).toEqual(['aaaaaaaa:fresh:l2']);
  });

  it('a healthy pin ignores the load it is ranked with, and does not move', () => {
    const repos = fakeRepos({
      pin: { connectionId: 'aaaaaaaa-1', pinnedAt: iso(-HOUR) },
      pins: { 'aaaaaaaa-1': 9 },
    });
    const d = selectAndReserve({
      sessionHash: 'sha256:old',
      model: 'm',
      accounts: [fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')],
      now: NOW,
      registry: ungated(),
      repos,
    });
    expect(d.connection.id).toBe('aaaaaaaa-1');
    expect(d.reason).toBe('pinned');
    // The load IS read (a pin whose account went unusable is a fresh placement
    // and has to spread), and a healthy pin discards it: nine live pins on the
    // pinned account against an idle alternative still holds the session.
    expect(repos.countActivePins).toHaveBeenCalledWith({ model: 'm', now: NOW });
  });

  it('a pin whose account went unusable rotates to the LIGHTEST account, not the first', () => {
    const repos = fakeRepos({
      pin: { connectionId: 'aaaaaaaa-1', pinnedAt: iso(-HOUR) },
      pins: { 'aaaaaaaa-1': 9, 'bbbbbbbb-2': 3 },
    });
    const d = selectAndReserve({
      sessionHash: 'sha256:old',
      model: 'm',
      accounts: [
        { id: 'aaaaaaaa-1', windows: [w(0)] },
        fresh('bbbbbbbb-2'),
        fresh('cccccccc-3'),
      ],
      now: NOW,
      registry: ungated(),
      repos,
    });
    expect(d.connection.id).toBe('cccccccc-3');
  });
});

// Money safety: a warm prompt cache is never spent on a rotation the load
// spread wanted. rankAccounts orders NEW pins by headroom and load, and
// decideRepin re-asks it, so the guard is that its return path is unreachable
// while the pin is eligible. `pin-healthy` at repinPolicy.js sits ahead of it:
// the only input that ever reaches the rule 5 return is a pin the ranker has
// already dropped from `eligible`, meaning depleted, gone from the cohort, or
// explicitly unavailable. Every other input takes the stay path.
describe('decideRepin: load never spends a warm cache', () => {
  const cohort = [fresh('aaaaaaaa-1'), fresh('bbbbbbbb-2')];
  const pinnedAt = iso(-HOUR);

  it('holds a healthy pin no matter how loaded it is against an idle alternative', () => {
    for (const pins of [1, 5, 50]) {
      const d = decideRepin({
        pin: { connectionId: 'aaaaaaaa-1', pinnedAt },
        accounts: cohort,
        now: NOW,
        activeLoad: load({ 'aaaaaaaa-1': pins }),
      });
      expect(d.action).toBe('keep');
      expect(d.reason).toBe('pin-healthy');
      expect(d.trigger).toBeNull();
    }
  });

  it('holds a healthy pin that is under the headroom floor, which only orders NEW pins', () => {
    const under = { id: 'aaaaaaaa-1', windows: [w(headroomFloorOf(1000) - 1)] };
    const d = decideRepin({
      pin: { connectionId: 'aaaaaaaa-1', pinnedAt },
      accounts: [under, fresh('bbbbbbbb-2')],
      now: NOW,
      activeLoad: load({ 'aaaaaaaa-1': 4 }),
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('pin-healthy');
  });

  it('repins only once the pin is INELIGIBLE, and then the load picks where', () => {
    const drained = { id: 'aaaaaaaa-1', windows: [w(0)] };
    const d = decideRepin({
      pin: { connectionId: 'aaaaaaaa-1', pinnedAt },
      accounts: [drained, fresh('bbbbbbbb-2'), fresh('cccccccc-3')],
      now: NOW,
      activeLoad: load({ 'bbbbbbbb-2': 3 }),
    });
    expect(d.action).toBe('repin');
    expect(d.connectionId).toBe('cccccccc-3');
    expect(d.reason).toBe('pinned-window-exhausted');
  });
});

describe('schedulerRepos.countActivePins: one grouped SELECT over live pins for the model', () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  afterEach(() => {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('counts expiring-in-future and no-TTL rows for the model, skips expired rows and other models', async () => {
    delete global._dbAdapter;
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-load-spread-'));
    process.env.DATA_DIR = tempDir;
    await (await import('@/lib/db/driver.js')).getAdapter();
    const affinity = await import('@/lib/db/repos/sessionAffinityRepo.js');
    const { createSchedulerRepos } = await import('@/sse/services/schedulerRepos.js');

    await affinity.setPin('s1', 'm', 'conn-a', { expiresAt: iso(HOUR) });
    await affinity.setPin('s2', 'm', 'conn-a', { expiresAt: null });
    await affinity.setPin('s3', 'm', 'conn-a', { expiresAt: iso(-1) });
    await affinity.setPin('s4', 'm', 'conn-b', { expiresAt: iso(HOUR) });
    await affinity.setPin('s5', 'other', 'conn-b', { expiresAt: iso(HOUR) });

    expect(await affinity.countActivePins('m', { now: new Date(NOW) })).toEqual({
      'conn-a': 2,
      'conn-b': 1,
    });
    const repos = await createSchedulerRepos({ now: NOW });
    expect(repos.countActivePins({ model: 'm', now: NOW })).toEqual({ 'conn-a': 2, 'conn-b': 1 });
    expect(repos.countActivePins({ model: 'none', now: NOW })).toEqual({});
  });
});
