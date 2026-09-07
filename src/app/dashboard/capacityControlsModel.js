export const DRAIN_ENDPOINT = '/api/admin/drain?all=true';
const errorText = (body, status) => body?.error?.message || body?.error || `Request refused (${status})`;

export async function applyDrainChanges(targets, isDraining, request = fetch, onOutcome = () => {}) {
  const outcomes = [];
  // Each account has its own optimistic version and mutation. Earlier successes
  // remain successful if a later account refuses; no atomic batch is implied.
  for (const target of targets) {
    let outcome;
    if (!target.version) outcome = { connectionId: target.connectionId, state: 'unavailable', message: 'No current drain version. Refresh before applying.' };
    else {
      try {
        const path = `/api/admin/drain/${encodeURIComponent(target.connectionId)}`;
        const response = await request(isDraining ? path : `${path}?${new URLSearchParams({ ifMatch: target.version })}`, {
          method: isDraining ? 'POST' : 'DELETE',
          ...(isDraining ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifMatch: target.version }) } : {}),
        });
        const body = await response.json();
        if (!response.ok) outcome = { connectionId: target.connectionId, state: response.status === 412 ? 'stale' : 'refused', message: errorText(body, response.status) };
        else {
          const readback = await request(DRAIN_ENDPOINT, { cache: 'no-store' });
          const current = await readback.json();
          const found = current.connections?.find(item => item.connectionId === target.connectionId);
          const confirmed = readback.ok && body.connectionId === target.connectionId && body.isDraining === isDraining
            && found?.isDraining === isDraining && found.version === body.version;
          outcome = { connectionId: target.connectionId, state: confirmed ? 'confirmed' : 'unconfirmed',
            message: confirmed ? `${isDraining ? 'Draining' : 'Drain stopped'}; saved state read back.` : 'Mutation returned, but matching saved state could not be confirmed. Refresh before retrying.',
            ...(confirmed ? { version: found.version, isDraining: found.isDraining, activeStreams: found.activeStreams } : {}) };
        }
      } catch (error) {
        outcome = { connectionId: target.connectionId, state: 'unconfirmed', message: `Outcome could not be confirmed. ${error.message}` };
      }
    }
    outcomes.push(outcome);
    onOutcome([...outcomes]);
  }
  return outcomes;
}

export function localCapacityState(account, drain) {
  if (!account.isActive) return 'Disabled';
  if (drain?.isDraining ?? account.isDraining) return 'Draining';
  if (account.status === 'cooldown') return 'Stored cooldown';
  return 'Model-specific check required';
}

export function retainAccountOrder(rows, ids) {
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.toSorted((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}

export function capacityAttemptSelection(record) {
  if (typeof record?.requestId !== 'string' || !record.requestId || record.id !== record.requestId
    || !Number.isSafeInteger(record.contextSessionId) || record.contextSessionId <= 0) return null;
  return { kind: 'context-attempt', id: record.requestId, sessionId: record.contextSessionId,
    provider: record.provider, model: record.model, connectionId: record.connectionId };
}
