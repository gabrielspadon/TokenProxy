import { getAdapter } from '@/lib/db/driver.js';
import { captureRoutingState } from './routingCapture.js';
import { simulateRouting } from '@/lib/routingSimulation.js';
import { getSessionPin, previewSessionPin, validatePinAction, PinControlError } from '@/lib/db/repos/sessionPinsRepo.js';

export async function previewPinChange(body, options) {
  validatePinAction(body);
  const pin = await getSessionPin(body.pinId), db = await getAdapter();
  const provider = db.get('SELECT provider FROM providerConnections WHERE id=?', [pin.connectionId])?.provider;
  let evidence = { readiness: 'unknown', localTarget: null, conflicts: [], unknownEvidence: ['future-request-restrictions', 'upstream-acceptance'],
    affectedSession: db.get("SELECT id, identitySource FROM contextSessions WHERE sessionHash=? AND identitySource IN ('explicit','inferred','routing')", [pin.sessionHash]) ?? null };
  if (body.action === 'reassign') {
    const target = db.get('SELECT provider FROM providerConnections WHERE id=?', [body.targetConnectionId]);
    if (!provider || !target || target.provider !== provider) throw new PinControlError('target_provider_mismatch', 422);
    const packet = await captureRoutingState({ input: { model: `${provider}/${pin.model}`, preferredConnectionId: body.targetConnectionId, strictPreferredConnection: true }, sessionHash: pin.sessionHash });
    if (packet.capture.scope.provider !== provider || packet.capture.scope.model !== pin.model) throw new PinControlError('unsupported_pin_topology', 422);
    const result = simulateRouting(packet);
    evidence = { ...evidence, observedAt: result.receipt.capturedAt, captureId: result.receipt.captureId,
      localTarget: result.localSelection, conflicts: result.exclusions.filter(e => e.connectionId === body.targetConnectionId),
      unknownEvidence: result.unknownEvidence, targetCandidate: result.candidates.find(c => c.connectionId === body.targetConnectionId) ?? null };
    // Reassignment is a fresh placement, not permission to reuse an existing
    // pin on a stale depleted hint. The live command uses this same ranker.
    const ranking = result.ranking.find(r => r.connectionId === body.targetConnectionId);
    if (ranking && !ranking.usable) {
      evidence.localTarget = { model: pin.model, connectionId: null, status: 'refused', reason: 'quota-window-excluded' };
      evidence.targetCandidate = null;
      if (!evidence.conflicts.some(c => c.reason === 'quota-window-excluded')) evidence.conflicts.push({ connectionId: body.targetConnectionId, reason: 'quota-window-excluded' });
    }
  }
  return previewSessionPin(body, evidence, options);
}
