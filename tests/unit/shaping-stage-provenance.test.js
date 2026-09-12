import { describe, expect, it } from 'vitest';
import { normalizeContextStages } from '../../src/lib/db/repos/contextRepo.js';
import { createStageGuard } from '../../open-sse/utils/stageOutcome.js';
import { getAdapter } from '../../src/lib/db/driver.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';
import { createContextTelemetry, nextContextAttempt } from '../../open-sse/handlers/chatCore/contextTelemetry.js';

describe('explicit shaping provenance', () => {
  it('keeps the source execution identity across dispatch retries and separates new preparation', async () => {
    const fields = { provider: 'fixture', model: 'fixture', connectionId: 'fixture', requestStartTime: Date.now() };
    const input = { logicalRequestId: 'same-work', stages: [{ stage: 'pxpipe', in: 100, out: 100, outcomeSource: 'execution', outcome: 'failed', errorCode: 'service_timeout' }] };
    const first = createContextTelemetry(input), retry = await nextContextAttempt(first, fields), independent = createContextTelemetry(input);
    expect(first.stages[0].executionRequestId).toBe(first.requestId);
    expect(retry.requestId).not.toBe(first.requestId);
    expect(retry.stages[0].executionRequestId).toBe(first.requestId);
    expect(independent.stages[0].executionRequestId).toBe(independent.requestId);
    const db = await getAdapter();
    const stored = db.all('SELECT requestId,executionRequestId FROM contextStages WHERE requestId IN (?,?)', [first.requestId, retry.requestId]);
    expect(stored).toHaveLength(2); expect(new Set(stored.map(row => row.executionRequestId))).toEqual(new Set([first.requestId]));
  });
  it('persists equal-byte application, failure and cancellation without guessing from bytes', async () => {
    const stages = [
      { stage: 'schema', in: 100, out: 100, outcome: 'applied', errorCode: null, outcomeSource: 'execution' },
      { stage: 'pxpipe', in: 100, out: 100, outcome: 'failed', errorCode: 'service_timeout', outcomeSource: 'execution' },
      { stage: 'headroom', in: 100, out: 100, outcome: 'cancelled', errorCode: 'caller_cancelled', outcomeSource: 'execution' },
    ];
    expect(normalizeContextStages(stages).map(row => row.outcome)).toEqual(['applied', 'failed', 'cancelled']);
    await saveRequestStats({ id: 'provenance-attempt', status: 'aborted', provider: 'fixture', model: 'fixture',
      contextTelemetry: { logicalRequestId: 'provenance-logical', attempt: 2, sessionHash: 'a'.repeat(64), dispatchCoverage: 'preparation-only', stages } });
    const db = await getAdapter();
    expect(db.get('SELECT logicalRequestId,attempt,dispatchCoverage FROM requestStats WHERE id=?', ['provenance-attempt']))
      .toEqual({ logicalRequestId: 'provenance-logical', attempt: 2, dispatchCoverage: 'preparation-only' });
    const saved = db.all('SELECT * FROM contextStages WHERE requestId=? ORDER BY ordinal', ['provenance-attempt']);
    expect(saved.map(row => [row.outcome, row.errorCode, row.outcomeSource, row.deltaBytes]))
      .toEqual([['applied', null, 'execution', 0], ['failed', 'service_timeout', 'execution', 0], ['cancelled', 'caller_cancelled', 'execution', 0]]);
  });
  it('keeps historical measurement provenance unknown and rejects forged outcome codes', () => {
    expect(normalizeContextStages([{ stage: 'rtk', in: 100, out: 80 }])[0])
      .toMatchObject({ outcomeSource: null, errorCode: null, deltaBytes: -20 });
    for (const extra of [{ outcome: 'failed', errorCode: 'secret request payload' }, { outcome: 'invented' },
      { outcome: 'failed', errorCode: 'caller_cancelled' }, { outcome: 'cancelled', errorCode: 'service_timeout' }]) {
      expect(() => normalizeContextStages([{ stage: 'rtk', in: 100, out: 100, outcomeSource: 'execution', ...extra }])).toThrow();
    }
  });
  it('rolls back a partially mutating failure, reports a bounded code, and continues once', async () => {
    let body = { text: 'original' }, calls = 0;
    const snapshot = JSON.stringify(body);
    const guard = createStageGuard({ rollback: () => { body = JSON.parse(snapshot); } });
    guard.sync('rtk', () => { body.text = 'damaged'; throw new Error('secret payload'); });
    await guard.async('pxpipe', async () => { calls++; throw new DOMException('private', 'TimeoutError'); });
    expect(body).toEqual({ text: 'original' }); expect(calls).toBe(1);
    expect(guard.measurement('rtk', true, false)).toMatchObject({ outcomeSource: 'execution', outcome: 'failed', errorCode: 'transform_exception', durationSource: 'monotonic' });
    expect(guard.measurement('pxpipe', true, false).errorCode).toBe('service_timeout');
    expect(guard.measurement('schema', true, true).outcome).toBe('applied');
  });

  it('records monotonic execution duration for applied, unchanged, skipped and failed-open stages', async () => {
    let tick = 100;
    const guard = createStageGuard({ rollback() {}, monotonic: () => tick });
    guard.sync('schema', () => { tick += 4; });
    guard.sync('thinking', () => { tick += 2; });
    guard.sync('privacy', () => { throw new Error('disabled stage ran'); }, false);
    await guard.async('pxpipe', async () => { tick += 7; throw new Error('fixture failure'); });
    const stages = [['schema', true, true], ['thinking', true, false], ['privacy', false, false], ['pxpipe', true, false]]
      .map(([stage, ran, changed]) => ({ stage, in: 100, out: 100, ...guard.measurement(stage, ran, changed) }));
    expect(stages.map((stage) => [stage.outcome, stage.durationMs, stage.durationSource]))
      .toEqual([['applied', 4, 'monotonic'], ['unchanged', 2, 'monotonic'], ['skipped', 0, 'monotonic'], ['failed', 7, 'monotonic']]);
    await saveRequestStats({ id: 'duration-proof', status: 'success', contextTelemetry: {
      logicalRequestId: 'duration-logical', sessionHash: 'b'.repeat(64), attempt: 1, stages,
    } });
    const db = await getAdapter();
    expect(db.all('SELECT durationMs,durationSource FROM contextStages WHERE requestId=? ORDER BY ordinal', ['duration-proof']))
      .toEqual([4, 2, 0, 7].map((durationMs) => ({ durationMs, durationSource: 'monotonic' })));
    expect(normalizeContextStages([{ stage: 'tools', in: 100, out: 100 }])[0])
      .toMatchObject({ durationMs: null, durationSource: 'unknown' });
    expect(() => normalizeContextStages([{ ...stages[0], durationMs: -1 }])).toThrow('Invalid stage duration');
  });

  it.each([false, null, undefined])('preserves an explicitly disabled stage gate %s', async (enabled) => {
    let calls = 0;
    const guard = createStageGuard({ rollback() {} });
    guard.sync('schema', () => { calls++; }, enabled);
    await guard.async('pxpipe', async () => { calls++; }, enabled);
    expect(calls).toBe(0);
    expect(guard.measurement('schema', false, false)).toMatchObject({ outcome: 'skipped', durationSource: 'monotonic' });
    expect(guard.measurement('pxpipe', false, false)).toMatchObject({ outcome: 'skipped', durationSource: 'monotonic' });
  });
});
