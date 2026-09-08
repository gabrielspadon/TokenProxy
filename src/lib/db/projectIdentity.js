import { normalizeContextIdentity } from './repos/contextEvidenceRepo.js';

export const PROJECT_BINDING_EFFECT = 'Every subsequent request using a bound key must supply authenticated client and project identity matching one of its bindings. Missing or unmatched identity is refused. Unbinding the last project restores ordinary key policy. In-flight work retains its original project and policy.';

export function trustedProjectIdentity(value, apiKeyId) {
  const identity = normalizeContextIdentity(value);
  if (!apiKeyId || identity.clientKeyId !== apiKeyId || identity.clientIdentitySource !== 'client-reported' || !identity.clientRef) return {};
  return identity;
}

// Binding is an operator decision. Client metadata alone never names a project.
export function resolveProjectBinding(db, apiKeyId, identity, refuse) {
  if (!apiKeyId || !db.get('SELECT id FROM projectBindings WHERE apiKeyId=? LIMIT 1', [apiKeyId])) return null;
  const clean = trustedProjectIdentity(identity, apiKeyId);
  if (!clean.projectRef) refuse('project-identity-required', 'This key requires its configured client and project identity. No generation was dispatched.');
  const binding = db.get('SELECT * FROM projectBindings WHERE apiKeyId=? AND clientRef=? AND projectRef=?', [apiKeyId, clean.clientRef, clean.projectRef]);
  if (!binding) refuse('project-identity-unbound', 'This client project is not bound to an application project for this key. No generation was dispatched.');
  const project = db.get('SELECT * FROM projects WHERE id=?', [binding.projectId]);
  if (!project || project.archived) refuse('project-unavailable', 'The bound project is archived or unavailable. No generation was dispatched.');
  return { binding, project, identity: clean };
}

export function usageProjectIdentity(db, { requestId, context, apiKeyId, logicalRequestId, attempt, provider, model, connectionId }) {
  const reservation = requestId ? db.get('SELECT * FROM apiKeyBudgetReservations WHERE requestId=?', [requestId]) : null;
  const request = requestId ? db.get('SELECT * FROM requestStats WHERE id=?', [requestId]) : null;
  const matches = row => row && Object.entries({ logicalRequestId, attempt, provider, model, connectionId })
    .every(([field, value]) => row[field] == null || value == null || row[field] === value);
  const principal = reservation?.apiKeyId ?? apiKeyId;
  const captured = trustedProjectIdentity(context?.explicitIdentity, principal);
  const retained = matches(request) ? trustedProjectIdentity(request, principal) : {};
  const frozen = trustedProjectIdentity(reservation, principal);
  const identity = frozen.clientRef ? frozen : captured.clientRef ? captured : retained;
  const contradiction = [frozen, captured, retained].some(candidate => candidate.clientRef && Object.entries(identity)
    .some(([field, value]) => value != null && candidate[field] != null && value !== candidate[field]));
  return {
    ...(contradiction ? {} : identity),
    projectId: reservation?.projectId ?? null,
    projectBindingId: reservation?.projectBindingId ?? null,
    projectPolicyRevision: reservation?.projectPolicyRevision ?? null,
  };
}
