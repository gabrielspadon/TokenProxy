import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES, FULL_DURATION_MS, FULL_REQUESTS, qualification, reconcile, resourceSummary, slope } from '../qa/reliability-soak/evidence.mjs';
import { artifactTreeSha256, clientRequest, configuration } from '../qa/reliability-soak/run.mjs';

const dirs = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const baseArgs = ['--artifacts=/tmp/soak-output', '--standalone-root=/tmp/soak-candidate', '--front-root=/tmp/soak-front', '--seed-script=/tmp/soak-seed.mjs', `--artifact-sha256=${'a'.repeat(64)}`, `--candidate-sha=${'b'.repeat(40)}`, `--front-sha=${'c'.repeat(40)}`, '--candidate-version=1.0.0'];

function evidence() {
  return {
    clients: [{ id: 'deterministic-0', case: 'json', state: 'passed', frontIngressId: 'front-1', logicalRequestId: 'logical-1' }],
    provider: [{ id: 'deterministic-0', model: 'fixture-model', contentStarted: true }],
    journal: { records: [
      { kind: 'start', frontIngressId: 'front-1' },
      { kind: 'terminal', frontIngressId: 'front-1', logicalRequestId: 'logical-1', state: 'succeeded' },
    ] },
    history: {
      front: [{ frontIngressId: 'front-1', logicalRequestId: 'logical-1', state: 'succeeded' }],
      attempts: [{ id: 'attempt-1', logicalRequestId: 'logical-1', status: 'success' }],
      logical: [{ logicalRequestId: 'logical-1', state: 'succeeded' }],
      usage: [{ requestId: 'attempt-1', logicalRequestId: 'logical-1' }],
      integrity: [{ quick_check: 'ok' }], foreignKeyViolations: [],
    },
  };
}

describe('reliability soak qualification boundaries', () => {
  it('requires exact artifact and both source identities', () => {
    expect(() => configuration(baseArgs.filter((arg) => !arg.startsWith('--front-sha=')))).toThrow(/front-sha/);
    expect(() => configuration(baseArgs.map((arg) => arg.startsWith('--candidate-sha=') ? '--candidate-sha=bbbbbbbbbbbb' : arg))).toThrow(/candidate-sha/);
    expect(() => configuration([...baseArgs, '--mode=full', '--requests=9999'])).toThrow(/cannot reduce/);
    expect(() => configuration([...baseArgs, '--duration-ms=3599999'])).toThrow(/cannot reduce/);
    expect(() => configuration([...baseArgs, '--sustained-ms=1000'])).toThrow(/cannot reduce/);
    expect(() => configuration([...baseArgs, '--concurency=8'])).toThrow(/unknown/);
  });

  it('keeps short smoke explicitly outside full qualification', () => {
    const fixture = {
      mode: 'smoke', errors: [], clients: CASES.map((scenario) => ({ case: scenario, phase: 'deterministic', state: 'passed' })),
      deterministicCompleted: FULL_REQUESTS, mixedDurationMs: FULL_DURATION_MS,
      cutovers: Array.from({ length: 6 }, () => ({ state: 'passed' })), dashboard: [{ state: 'passed' }],
      resources: [{}], quiescentResources: [{}], reconciliation: { state: 'passed' },
      cleanup: { gateway: { listenerGone: true }, front: { listenerGone: true }, provider: true },
    };
    expect(qualification(fixture)).toMatchObject({ state: 'not-run', smokeState: 'passed' });
    fixture.mode = 'full';
    expect(qualification(fixture).state).toBe('passed');
    fixture.clients[0].state = 'failed';
    expect(qualification(fixture).state).toBe('failed');
  });

  it('binds executable bytes, paths and modes and refuses external symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-tree-')); dirs.push(dir);
    writeFileSync(join(dir, 'server.js'), 'one', { mode: 0o600 });
    const before = artifactTreeSha256(dir);
    writeFileSync(join(dir, 'server.js'), 'two', { mode: 0o600 });
    expect(artifactTreeSha256(dir)).not.toBe(before);
    mkdirSync(join(dir, 'nested'));
    symlinkSync(join(dir, 'server.js'), join(dir, 'nested', 'link'));
    expect(() => artifactTreeSha256(dir)).toThrow(/symlink/);
  });
});

describe('independent terminal reconciliation', () => {
  it('accepts fully linked success with durable usage', () => {
    expect(reconcile(evidence())).toMatchObject({ state: 'passed', clients: 1, unsafeReplay: 0, stalePending: 0 });
  });
  it('catches unsafe replay even when both attempts returned identical content', () => {
    const fixture = evidence(); fixture.provider.push({ ...fixture.provider[0] });
    expect(reconcile(fixture)).toMatchObject({ state: 'failed', unsafeReplay: 1 });
  });
  it.each(['front', 'usage', 'logical'])( 'catches missing acknowledged %s persistence', (table) => {
    const fixture = evidence(); fixture.history[table] = [];
    expect(reconcile(fixture).state).toBe('failed');
  });
  it('catches a terminal recorded against a different logical request', () => {
    const fixture = evidence(); fixture.history.front[0].logicalRequestId = 'wrong-request';
    expect(reconcile(fixture).violations).toContain('journal ingestion loss or mismatch');
  });
  it('catches orphaned starts, duplicated terminals, stale attempts and FK corruption together', () => {
    const fixture = evidence();
    fixture.journal.records.push({ kind: 'start', frontIngressId: 'orphan' }, { ...fixture.journal.records[1] });
    fixture.history.attempts[0].status = 'pending';
    fixture.history.foreignKeyViolations.push({ table: 'usageHistory', rowid: 1 });
    const result = reconcile(fixture);
    expect(result.violations).toEqual(expect.arrayContaining(['duplicate front terminal', 'unexplained stale front pending', 'database integrity failure']));
    expect(result.stalePending).toBe(2);
  });
  it('requires no upstream dispatch for a rejected client and distinct cancellation', () => {
    const fixture = evidence(); fixture.clients[0].case = 'unauthorized';
    expect(reconcile(fixture).violations).toEqual(expect.arrayContaining(['rejected request dispatched deterministic-0']));
    fixture.clients[0].case = 'cancel';
    expect(reconcile(fixture).violations).toContain('cancellation misclassified deterministic-0');
  });
});

describe('resource time series', () => {
  it('reports slope per minute without wall clock arithmetic', () => {
    expect(slope([{ elapsedMs: 0, bytes: 10 }, { elapsedMs: 120_000, bytes: 30 }], 'bytes')).toBe(10);
    expect(slope([{ elapsedMs: 0, bytes: 10 }], 'bytes')).toBe(null);
    expect(slope([{ elapsedMs: 0, bytes: 10 }, { elapsedMs: 0, bytes: 30 }], 'bytes')).toBe(null);
  });
  it('separates monotonically growing descriptors from a stable queue', () => {
    const summary = resourceSummary(Array.from({ length: 6 }, (_, index) => ({ elapsedMs: index * 60_000, frontFdCount: 20 + index, queued: 0 })));
    expect(summary.frontFdCount).toMatchObject({ monotonicallyGrowing: true, slopePerMinute: 1 });
    expect(summary.queued).toMatchObject({ monotonicallyGrowing: false, slopePerMinute: 0 });
  });
});

describe('client observed stream truth', () => {
  it('fails a plausible partial response that lacks the terminal frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"content":"soak-content"}\n\n', { status: 200 })));
    expect(await clientRequest({ baseUrl: 'http://127.0.0.1:1', authorization: 'fixture', id: 'deterministic-0', scenario: 'stream', phase: 'deterministic' }))
      .toMatchObject({ state: 'failed', error: 'stream lacks terminal frame' });
  });
  it('rejects apparent successful completion after injected stream reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"content":"soak-content"}\n\ndata: [DONE]\n\n', { status: 200 })));
    expect(await clientRequest({ baseUrl: 'http://127.0.0.1:1', authorization: 'fixture', id: 'deterministic-1', scenario: 'stream-reset', phase: 'deterministic' }))
      .toMatchObject({ state: 'failed', error: 'abrupt provider stream became an apparent completed stream' });
  });
});
