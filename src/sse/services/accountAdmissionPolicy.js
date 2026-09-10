import { accountSupportsModel } from '@/shared/utils/accountModelEligibility.js';
import { classifyAccountFailure } from '@/shared/utils/accountFailureClass.js';
import { getActiveModelFailure, isModelLockActive } from 'open-sse/services/accountFallback.js';

/** The gateway's pre-quota account gate. Callers supply resolved operator state. */
// An account that holds no credential at all cannot answer. Admitting it only
// spends a cascade slot on an upstream 401, which a client such as Claude Code
// then reads as its own sign-out ("Not logged in") while the real accounts
// were merely out of quota. Cookie, public and credential-free providers keep
// their access elsewhere, so only the two credential-bearing types are judged.
// Live selection applies this before admission; a captured account for the
// routing simulation carries no secret, so the simulator does not judge it.
export function holdsCredential(connection) {
  const type = connection.authType;
  if (type === 'apikey' || type === 'api_key') return Boolean(connection.apiKey);
  if (type === 'oauth' || type === 'access_token') return Boolean(connection.accessToken || connection.refreshToken);
  return true;
}

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
