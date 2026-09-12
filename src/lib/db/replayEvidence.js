import { isReplaySafeRejection, isSafeQuotaAccountRejection } from '../../../open-sse/utils/replaySafety.js';

export const REQUEST_REPLAY_COLUMNS = {
  replayDisposition: "TEXT CHECK (replayDisposition IS NULL OR replayDisposition IN ('safe-rejection','never-replay','unknown'))",
  replaySource: "TEXT CHECK (replaySource IS NULL OR replaySource IN ('upstream-response','dispatch-start','transport-no-dispatch'))",
  replayStatus: 'INTEGER CHECK (replayStatus IS NULL OR (replayStatus >= 100 AND replayStatus < 600))',
  replayObservedAt: 'TEXT',
};
const NONACCEPTANCE = new Set(['verified-provider-nonacceptance', 'model-endpoint-unsupported']);

// Called only from the existing owned physical-response callback. The bounded
// provider rejection proof is the same one used by the retry/budget planner.
export function replayResponseEvidence({ response, nonacceptance, payload } = {}, now = () => new Date().toISOString()) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status >= 600) return null;
  const explicitlyForbidden = response.headers?.get?.('x-tokenproxy-replay-safe') === 'false'
    || response.headers?.get?.('x-should-retry') === 'false';
  // This records generation nonacceptance, not same-account retry permission.
  // A canonical account quota rejection can forbid retrying that account.
  const permitted = isSafeQuotaAccountRejection(response, payload) || (!explicitlyForbidden && response.status >= 400
    && (NONACCEPTANCE.has(nonacceptance) || isReplaySafeRejection(response, payload)));
  return { disposition: permitted ? 'safe-rejection' : 'never-replay', source: 'upstream-response',
    status: response.status, observedAt: now() };
}

export function normalizeReplayEvidence(value) {
  if (value == null) return null;
  const { disposition, source, status = null, observedAt } = value;
  if (!['safe-rejection', 'never-replay', 'unknown'].includes(disposition)
    || !['upstream-response', 'dispatch-start', 'transport-no-dispatch'].includes(source)
    || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt
    || (source === 'upstream-response' ? !Number.isInteger(status) || status < 100 || status >= 600 : status !== null)
    || (source === 'upstream-response' && (disposition === 'unknown' || disposition === 'safe-rejection' && status < 400))
    || (source === 'dispatch-start' && disposition !== 'unknown')
    || (source === 'transport-no-dispatch' && disposition !== 'safe-rejection')) throw new Error('Invalid replay evidence');
  return { replayDisposition: disposition, replaySource: source, replayStatus: status, replayObservedAt: observedAt };
}
