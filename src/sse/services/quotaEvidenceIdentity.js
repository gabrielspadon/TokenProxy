import { createHash } from 'node:crypto';
import { credentialRevision } from 'open-sse/services/tokenRefresh/credentialRevision.js';

// A credential or route change invalidates both successful and failed reads.
// Only this opaque digest is retained with an observation, never credentials
// or proxy URLs. Routing cannot relabel an unbound legacy observation.
export function quotaEvidenceIdentity(connection, proxyOptions = null) {
  return createHash('sha256').update(JSON.stringify({ id: connection.id,
    credentialRevision: credentialRevision(connection),
    quotaPauseThresholds: connection.quotaPauseThresholds, proxyOptions })).digest('hex');
}

export function bindQuotaSnapshot(connection, proxyOptions, snapshot) {
  return snapshot ? { ...snapshot, evidenceIdentity: quotaEvidenceIdentity(connection, proxyOptions) } : null;
}
