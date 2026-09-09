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
    expect(guard.measurement('rtk', true, false)).toEqual({ outcomeSource: 'execution', outcome: 'failed', errorCode: 'transform_exception' });
    expect(guard.measurement('pxpipe', true, false).errorCode).toBe('service_timeout');
    expect(guard.measurement('schema', true, true).outcome).toBe('applied');
  });
});
