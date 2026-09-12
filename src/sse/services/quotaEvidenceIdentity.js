import { createHash } from 'node:crypto';
import { credentialRevision } from 'open-sse/services/tokenRefresh/credentialRevision.js';

// A credential or route change invalidates both successful and failed reads.
// The digest is process-local cache identity, never an exported credential ID.
export function quotaEvidenceIdentity(connection, proxyOptions = null) {
  return createHash('sha256').update(JSON.stringify({ id: connection.id,
    credentialRevision: credentialRevision(connection),
    quotaPauseThresholds: connection.quotaPauseThresholds, proxyOptions })).digest('hex');
}
