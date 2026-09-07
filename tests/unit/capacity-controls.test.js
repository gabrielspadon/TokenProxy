import { describe, expect, it, vi } from 'vitest';
import { applyDrainChanges, capacityAttemptSelection, DRAIN_ENDPOINT, localCapacityState, retainAccountOrder } from '@/app/dashboard/capacityControlsModel';
const response = (body, status = 200) => Response.json(body, { status });
const target = id => ({ connectionId: id, version: `v-${id}` });

describe('per-account drain confirmation', () => {
  it('opens only an exact physical activity record with an explicit retained session', () => {
    const record = { id: 'attempt-a', requestId: 'attempt-a', logicalRequestId: 'logical-b', contextSessionId: 12, provider: 'anthropic', model: 'served-model', connectionId: 'account-a' };
    expect(capacityAttemptSelection(record)).toEqual({ kind: 'context-attempt', id: 'attempt-a', sessionId: 12, provider: 'anthropic', model: 'served-model', connectionId: 'account-a' });
    for (const change of [{ requestId: 'logical-b' }, { contextSessionId: null }, { contextSessionId: 0 }, { contextSessionId: '12' }, { requestId: '' }]) expect(capacityAttemptSelection({ ...record, ...change })).toBeNull();
    expect(capacityAttemptSelection(null)).toBeNull();
  });
  it('keeps inspected rows ordered during live updates and appends new accounts', () => {
    const incoming = [{id:'b',records:90},{id:'new',records:80},{id:'a',records:50}];
    expect(retainAccountOrder(incoming,['a','b']).map(row => row.id)).toEqual(['a','b','new']);
    expect(incoming.map(row => row.id)).toEqual(['b','new','a']);
    expect(retainAccountOrder(incoming,['a','b'])[0].records).toBe(50);
  });
  it('keeps a confirmed success and later stale refusal separate', async () => {
    const saved = { connectionId: 'a', isDraining: true, version: 'saved-a', activeStreams: 3 };
    const request = vi.fn().mockResolvedValueOnce(response(saved))
      .mockResolvedValueOnce(response({ connections: [saved] }))
      .mockResolvedValueOnce(response({ error: { message: 'State changed' } }, 412));
    const results = await applyDrainChanges([target('a'), target('b')], true, request);
    expect(results.map(item => item.state)).toEqual(['confirmed', 'stale']);
    expect(results[0].activeStreams).toBe(3);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ ifMatch: 'v-a' });
    expect(request.mock.calls[1][0]).toBe(DRAIN_ENDPOINT);
    expect(request.mock.calls).toHaveLength(3);
  });
  it('never reports an HTTP success with a different readback version as persisted', async () => {
    const request = vi.fn().mockResolvedValueOnce(response({ connectionId: 'a', isDraining: true, version: 'v1' }))
      .mockResolvedValueOnce(response({ connections: [{ connectionId: 'a', isDraining: true, version: 'v2' }] }));
    expect((await applyDrainChanges([target('a')], true, request))[0].state).toBe('unconfirmed');
  });
  it('uses the query version when reversing and refuses missing versions before mutation', async () => {
    const saved = { connectionId: 'a / b', version: 'restored', isDraining: false };
    const request = vi.fn().mockResolvedValueOnce(response(saved)).mockResolvedValueOnce(response({ connections: [saved] }));
    expect((await applyDrainChanges([target('a / b')], false, request))[0].state).toBe('confirmed');
    expect(request.mock.calls[0][0]).toBe('/api/admin/drain/a%20%2F%20b?ifMatch=v-a+%2F+b');
    expect(request.mock.calls[0][1]).toEqual({ method: 'DELETE' });
    request.mockClear();
    expect((await applyDrainChanges([{ connectionId: 'a' }], true, request))[0].state).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves uncertain network outcomes and does not retry an unknown mutation', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Connection ended'));
    expect((await applyDrainChanges([target('a')], true, request))[0].state).toBe('unconfirmed');
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not infer capacity or entitlement from healthy status or absent quota', () => {
    expect(localCapacityState({ isActive: true, status: 'healthy' }, null)).toBe('Model-specific check required');
    expect(localCapacityState({ isActive: true, status: 'healthy' }, { isDraining: true })).toBe('Draining');
    expect(localCapacityState({ isActive: false }, { isDraining: true })).toBe('Disabled');
  });
});
