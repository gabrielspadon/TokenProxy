import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth.js is the ONLY printing file in the selection stack
// (docs/logging-design.md step 3.2): quotaRanking, repinPolicy,
// accountScheduler and the lease registry return verdicts, auth.js emits them
// through decide(). These tests capture the real console lines the real
// decide() writes and assert their k=v shapes, mirroring
// tests/unit/decision-log.test.js's capture approach.

const PROVIDER = 'claude';
const MODEL = 'claude-sonnet-4';
const RID = 'a3f9c1d2';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
  updateConnectionProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  updateProviderStrategyProxyPoolSnapshotIfBound: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));
const quotaMocks = vi.hoisted(() => ({
  evaluateQuota: vi.fn(async () => ({ paused: false, reason: 'disabled', snapshot: null })),
}));
const proxyMocks = vi.hoisted(() => ({
  pickProxyPoolId: vi.fn(() => null),
  resolveConnectionProxyConfig: vi.fn(async () => ({ kind: 'usable' })),
  toConnectionProxyOptions: vi.fn(() => ({ connectionProxyEnabled: false })),
}));

vi.mock('@/lib/localDb', () => dbMocks);
vi.mock('@/lib/network/connectionProxy', () => proxyMocks);
vi.mock('@/shared/constants/providers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  FREE_TIER_PROVIDERS: {},
  NO_AUTH_PROVIDER_IDS: [],
  resolveProviderId: (provider) => provider,
  isNoAuthProvider: () => false,
  isProviderDisabled: () => false,
}));
vi.mock('@/sse/services/quotaGuard.js', () => quotaMocks);
vi.mock('@/sse/utils/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let auth;
let state;
let leases;
let adapter;
let logSpy;
let decideModule;

function connection(id, { key, maxConcurrent = 8, snapshot = null, extra = {} } = {}) {
  return {
    id,
    name: `account-${id}`,
    provider: PROVIDER,
    authType: 'api_key',
    apiKey: key,
    isActive: true,
    testStatus: 'active',
    maxConcurrent,
    lastQuotaSnapshot: snapshot,
    providerSpecificData: {},
    ...extra,
  };
}

function snapshot(remainingPercentage, { resetOffsetMs = 5 * HOUR } = {}) {
  return {
    windows: [{ key: 'session (5h)', remainingPercentage, resetAt: new Date(Date.now() + resetOffsetMs).toISOString(), limit: 100 }],
    fetchedAt: new Date().toISOString(),
  };
}

const KEY_A = 'sk-fake-testonly-emissa0000aaaa0000aaaa';
const KEY_B = 'sk-fake-testonly-emissb1111bbbb1111bbbb';
const connA = () => connection('conn_aaaaaaaa', { key: KEY_A, snapshot: snapshot(60, { resetOffsetMs: 1 * HOUR }) });
const connB = () => connection('conn_bbbbbbbb', { key: KEY_B, snapshot: snapshot(60, { resetOffsetMs: 2 * HOUR }) });

function clientOptions(sessionId, extra = {}) {
  return { clientHeaders: { 'x-session-id': sessionId }, logCtx: { rid: RID }, ...extra };
}

async function loadModules() {
  delete global._dbAdapter;
  vi.resetModules();
  process.env.DATA_DIR = tempDir;
  const { getAdapter } = await import('@/lib/db/driver.js');
  adapter = await getAdapter();
  auth = await import('@/sse/services/auth.js');
  state = await import('@/lib/admin/state.js');
  leases = await import('@/sse/services/accountLeaseRegistry.js');
  // The same module instance auth.js emits through: vi.resetModules gives
  // every suite-load a fresh singleton, so resetState must target THIS one.
  decideModule = await import('@/shared/observability/decide.js');
}

/** Every decision-log line emitted since the spy was installed. */
function emitted() {
  return logSpy.mock.calls.map((c) => String(c[0])).filter((l) => / (SEL|RANK|LEASE|LOCK)\./.test(l));
}
const findLine = (clsVerdict) => emitted().find((l) => l.includes(` ${clsVerdict} `));

beforeEach(async () => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-emit-'));
  await loadModules();
  decideModule.__decide.resetState();
  decideModule.__decide.disableSink();
  quotaMocks.evaluateQuota.mockImplementation(async () => ({ paused: false, reason: 'disabled', snapshot: null }));
  proxyMocks.resolveConnectionProxyConfig.mockImplementation(async () => ({ kind: 'usable' }));
  dbMocks.getProviderConnections.mockImplementation(async () => [connA(), connB()]);
});

afterEach(async () => {
  logSpy.mockRestore();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  await adapter?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('auth.js selection emissions', () => {
  it('emits SEL.win with the worked-example field shape and the repin receipt as rcpt', async () => {
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-win'));
    expect(picked.connectionId).toBe('conn_aaaaaaaa');
    console.warn('DUMP', JSON.stringify(logSpy.mock.calls.map((c) => String(c[0])), null, 1));
    const win = findLine('SEL.win');
    expect(win).toBeDefined();
    expect(win).toContain(`rid=${RID}`);
    expect(win).toContain(`model=${MODEL}`);
    expect(win).toContain('conn=conn_aaa');
    expect(win).toContain('key=reset-horizon');
    expect(win).toContain('win=true');
    expect(win).toMatch(/rem=\d+/);
    // Percentage-only windows carry confidence=unknown by the honesty rule.
    expect(win).toContain('alt=conn_bbb:unknown');
    expect(win).toContain('why=initial-pin');

    const repin = findLine('SEL.repin');
    expect(repin).toContain('from=none');
    expect(repin).toContain('to=conn_aaa');
    expect(repin).toContain('trigger=initial-pin');
    expect(repin).toMatch(/rcpt=[0-9a-f-]{36}/);

    // The retired INFO line is gone; the verdict rides the decision log.
    expect(emitted().some((l) => l.includes('selected ('))).toBe(false);
    // The pin-hit info reaches the caller's return for the later REQ sel= wave.
    expect(picked.selection).toMatchObject({ verdict: 'win', conn: 'conn_aaa' });
    leases.releaseAccountLease(picked.accountLease);
  });

  it('keeps a healthy pin silent (no pin-hit line) but reports it on the return', async () => {
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-pin'));
    leases.releaseAccountLease(first.accountLease);
    logSpy.mockClear();

    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-pin'));
    expect(second.connectionId).toBe('conn_aaaaaaaa');
    expect(emitted().some((l) => l.includes('SEL.pin-hit'))).toBe(false);
    const win = findLine('SEL.win');
    expect(win).toContain('why=operator-pinned');
    expect(second.selection.verdict).toBe('pin-hit');
    leases.releaseAccountLease(second.accountLease);
  });

  it('emits SEL.repin with from/to/trigger/rcpt when the pin moves', async () => {
    // Pin A by exhausting B at pin time...: simpler, pin A via session, then
    // drain A so the next request for the session must move.
    const first = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-move'));
    leases.releaseAccountLease(first.accountLease);
    await state.writeDrainDoc('conn_aaaaaaaa', { isDraining: true, requestedAt: iso(0), completedAt: null });
    logSpy.mockClear();

    const second = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-move'));
    expect(second.connectionId).toBe('conn_bbbbbbbb');
    const repin = findLine('SEL.repin');
    expect(repin).toContain('from=conn_aaa');
    expect(repin).toContain('to=conn_bbb');
    expect(repin).toContain('trigger=unavailable');
    expect(repin).toMatch(/rcpt=[0-9a-f-]{36}/);
    const drain = findLine('SEL.drain-excluded');
    expect(drain).toContain(`rid=${RID}`);
    expect(drain).toContain('alt=conn_aaa');
    leases.releaseAccountLease(second.accountLease);
  });

  it('emits SEL.operator-pinned when the operator named the connection', async () => {
    const picked = await auth.getProviderCredentials(
      PROVIDER, null, MODEL, clientOptions('sess-op', { preferredConnectionId: 'conn_bbbbbbbb' }),
    );
    expect(picked.connectionId).toBe('conn_bbbbbbbb');
    const line = findLine('SEL.operator-pinned');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_bbb');
    expect(line).toMatch(/why=\S+/);
    expect(picked.selection.verdict).toBe('operator-pinned');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('emits LEASE.refused with held/cap/next/retry_after when the pinned slot is full', async () => {
    dbMocks.getProviderConnections.mockImplementation(async () => [
      connA(),
      connection('conn_bbbbbbbb', { key: KEY_B, maxConcurrent: 1, snapshot: snapshot(60, { resetOffsetMs: 2 * HOUR }) }),
    ]);
    leases._getLeaseRegistry().reserve('conn_bbbbbbbb');
    const picked = await auth.getProviderCredentials(
      PROVIDER, null, MODEL, clientOptions('sess-lease', { preferredConnectionId: 'conn_bbbbbbbb' }),
    );
    expect(picked.allRateLimited).toBe(true);
    const line = findLine('LEASE.refused');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_bbb');
    expect(line).toContain('held=1');
    expect(line).toContain('cap=1');
    expect(line).toMatch(/next=\d+s/);
    expect(line).toMatch(/retry_after=\d+s/);
  });

  it('emits LEASE.ungated when capacity was never registered (fail-open speaks)', async () => {
    dbMocks.getProviderConnections.mockImplementation(async () => [
      connection('conn_uuuuuuuu', { key: KEY_A, maxConcurrent: 0, snapshot: snapshot(60) }),
    ]);
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-ungated'));
    expect(picked.connectionId).toBe('conn_uuuuuuuu');
    const line = findLine('LEASE.ungated');
    expect(line).toContain('conn=conn_uuu');
    expect(line).toContain('why=capacity-unregistered');
    expect(line).toContain('held=1');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('emits SEL.quota-paused and SEL.quota-unknown for the two quota exits', async () => {
    dbMocks.getProviderConnections.mockImplementation(async () => [
      connA(),
      connection('conn_pppppppp', { key: KEY_B, snapshot: snapshot(60) }),
      connection('conn_uuuuuuuu', { key: KEY_B, snapshot: snapshot(60) }),
    ]);
    quotaMocks.evaluateQuota.mockImplementation(async (c) => {
      if (c.id === 'conn_pppppppp') return { paused: true, reason: 'below-threshold', snapshot: null };
      if (c.id === 'conn_uuuuuuuu') throw new Error('repo read exploded');
      return { paused: false, reason: 'ok', snapshot: c.lastQuotaSnapshot };
    });
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-quota'));
    expect(picked.connectionId).toBe('conn_aaaaaaaa');

    const paused = findLine('SEL.quota-paused');
    expect(paused).toContain('conn=conn_ppp');
    expect(paused).toContain('why=window-below-threshold');
    const unknown = findLine('SEL.quota-unknown');
    expect(unknown).toContain('conn=conn_uuu');
    expect(unknown).toContain('why=evidence-absent-not-empty');
    leases.releaseAccountLease(picked.accountLease);
  });

  it('emits SEL.model-locked with the lock key and expiry', async () => {
    dbMocks.getProviderConnections.mockImplementation(async () => [
      connection('conn_llllllll', {
        key: KEY_A,
        snapshot: snapshot(60),
        extra: { 'modelLock_claude-sonnet-4': new Date(Date.now() + 2 * HOUR).toISOString() },
      }),
      connB(),
    ]);
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-lock'));
    expect(picked.connectionId).toBe('conn_bbbbbbbb');
    const line = findLine('SEL.model-locked');
    expect(line).toContain('conn=conn_lll');
    expect(line).toContain('lock=modelLock_claude-sonnet-4');
    expect(line).toMatch(/until=\d{4}-/);
    leases.releaseAccountLease(picked.accountLease);
  });

  it('emits SEL.proxy-unusable with pool and resolution kind, releasing the slot', async () => {
    proxyMocks.resolveConnectionProxyConfig.mockImplementation(async () => ({ kind: 'unreachable' }));
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-proxy'));
    expect(picked).toBeNull();
    const line = findLine('SEL.proxy-unusable');
    expect(line).toContain('conn=conn_aaa');
    expect(line).toContain(`prov=${PROVIDER}`);
    expect(line).toContain('why=unreachable');
    expect(leases._getLeaseRegistry().inFlight('conn_aaaaaaaa')).toBe(0);
  });

  it('emits SEL.skipped and SEL.refused when nothing can serve', async () => {
    dbMocks.getProviderConnections.mockImplementation(async () => [
      connection('conn_dddddddd', { key: KEY_A, snapshot: snapshot(0, { resetOffsetMs: 1 * HOUR }) }),
      connection('conn_eeeeeeee', { key: KEY_B, snapshot: snapshot(0, { resetOffsetMs: 2 * HOUR }) }),
    ]);
    quotaMocks.evaluateQuota.mockImplementation(async (c) => ({ paused: false, reason: 'ok', snapshot: c.lastQuotaSnapshot }));
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, clientOptions('sess-refused'));
    // Both accounts read remaining=0 against a window that has not reset yet,
    // so there is nothing to serve. The degraded path used to hand one out
    // anyway — `eligible` was empty while `ranked` still offered every record —
    // and the caller paid a 429 to discover what the ranking already knew.
    // Since b09a9277 eligibility is authoritative on every path, so a pool with
    // no headroom refuses, and the refusal carries the earliest projected reset
    // as its retry-after instead of a flat one-second floor.
    expect(picked.allRateLimited).toBe(true);
    expect(picked.connectionId).toBeUndefined();
    expect(picked.retryAfter).toMatch(/^\d{4}-/);

    const depleted = findLine('RANK.depleted');
    expect(depleted).toContain('win=false');
    expect(depleted).toContain('alt=conn_ddd:unknown,conn_eee:unknown');
    expect(depleted).toMatch(/reset=\d{4}-/);
    // And the refusal is now printed under its own name, which is what this
    // test was always called after.
    const refused = findLine('SEL.refused');
    expect(refused).toBeDefined();
  });

  it('omits rid when no log context was threaded (background selection)', async () => {
    const picked = await auth.getProviderCredentials(PROVIDER, null, MODEL, { clientHeaders: { 'x-session-id': 'sess-bg' } });
    expect(picked.connectionId).toBe('conn_aaaaaaaa');
    const lines = emitted();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(`rid=${RID}`);
    expect(lines.every((l) => !/\brid=/.test(l))).toBe(true);
    leases.releaseAccountLease(picked.accountLease);
  });
});

describe('auth.js LOCK emissions (markAccountUnavailable)', () => {
  const unavailable = (status, text, provider, { resetsAtMs = null, log = { rid: RID } } = {}) =>
    auth.markAccountUnavailable('conn_aaaaaaaa', status, text, provider, MODEL, resetsAtMs, null, log);

  it('LOCK.applied class=credential on a 401 has expect_reset=false (the timed-backoff misreport)', async () => {
    await unavailable(401, 'OAuth access token has been revoked.', 'claude');
    const line = findLine('LOCK.applied');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_aaa');
    expect(line).toContain(`prov=${PROVIDER}`);
    expect(line).toContain(`model=${MODEL}`);
    expect(line).toContain('status=401');
    expect(line).toContain('class=credential');
    expect(line).toContain('sched=backoff');
    expect(line).toContain('level=0');
    expect(line).toMatch(/cooldown=\d+s/);
    expect(line).toMatch(/cap=\d+s/);
    expect(line).toContain('why=no-permanent-path-for-provider');
    expect(line).toContain('expect_reset=false');
    expect(emitted().some((l) => l.includes('locked modelLock_'))).toBe(false);
  });

  it('LOCK.applied class=rate on a temporary 429 has expect_reset=true', async () => {
    await unavailable(429, 'rate limit exceeded', 'claude');
    const line = findLine('LOCK.applied');
    expect(line).toContain('status=429');
    expect(line).toContain('class=rate');
    expect(line).toContain('why=retry-after');
    expect(line).toContain('expect_reset=true');
  });

  it('LOCK.clamped reports requested vs applied when a provider reset hits the cap', async () => {
    await unavailable(429, 'rate limit exceeded', 'claude', { resetsAtMs: Date.now() + 3 * DAY });
    const line = findLine('LOCK.clamped');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_aaa');
    expect(line).toMatch(/requested=\d+s/);
    expect(line).toMatch(/applied=\d+s/);
    expect(line).not.toContain('requested=applied');
  });

  it('LOCK.permanent on the Codex deactivation path', async () => {
    await unavailable(401, 'invalidated oauth token', 'codex');
    const line = findLine('LOCK.permanent');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_aaa');
    expect(line).toContain('prov=codex');
    expect(line).toContain(`model=${MODEL}`);
    expect(line).toContain('status=401');
    expect(line).toContain('class=credential');
    expect(line).toContain('expect_reset=false');
  });

  it('LOCK.monthly-reset on the GitHub usage-limit path', async () => {
    await unavailable(402, "You've reached your additional usage limit for your plan", 'github');
    const line = findLine('LOCK.monthly-reset');
    expect(line).toContain(`rid=${RID}`);
    expect(line).toContain('conn=conn_aaa');
    expect(line).toContain('prov=github');
    expect(line).toContain('status=402');
    expect(line).toMatch(/reset=\d{4}-\d{2}-01T00:00:00/);
    expect(line).toContain('why=usage-limit');
  });

  it('omits rid when markAccountUnavailable has no log context', async () => {
    await auth.markAccountUnavailable('conn_aaaaaaaa', 429, 'rate limit exceeded', 'claude', MODEL);
    const line = findLine('LOCK.applied');
    expect(line).toBeDefined();
    expect(line).not.toContain('rid=');
  });
});
