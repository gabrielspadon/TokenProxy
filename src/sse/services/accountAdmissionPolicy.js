import { accountSupportsModel } from '@/shared/utils/accountModelEligibility.js';
import { classifyAccountFailure } from '@/shared/utils/accountFailureClass.js';
import { getActiveModelFailure, isModelLockActive } from 'open-sse/services/accountFallback.js';

/** The gateway's pre-quota account gate. Callers supply resolved operator state. */
export function accountAdmissionReason(connection, { model, preferredConnectionId = null,
  strictPreferredConnection = false, excluded = false, disabled = false,
  draining = false, ignoreLockConn = null, now = Date.now() } = {}) {
  if (strictPreferredConnection && connection.id !== preferredConnectionId) return 'strict-account-mismatch';
  if (excluded) return 'request-excluded';
  if (!accountSupportsModel(connection, model)) return 'account-model-excluded';
  if (disabled) return 'model-disabled';
  if (draining) return 'account-draining';
  if (connection.id !== ignoreLockConn && isModelLockActive(connection, model, now)) return 'model-locked';
  return null;
}

/** Temporary failures preserve an otherwise admissible session's account. */
export function temporaryPinWait(connection, options = {}) {
  if (!connection || accountAdmissionReason(connection, options) !== 'model-locked') return null;
  const failure = getActiveModelFailure(connection, options.model, options.now);
  const failureClass = failure && (connection[failure.failureKey]?.failureClass
    || classifyAccountFailure(failure.status, failure.message));
  return failure && ['rate', 'transient'].includes(failureClass) ? { ...failure, failureClass } : null;
}
