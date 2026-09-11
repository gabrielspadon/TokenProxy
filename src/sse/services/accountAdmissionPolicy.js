import { accountSupportsModel } from '@/shared/utils/accountModelEligibility.js';
import { getExhaustedQuotaWindow } from 'open-sse/services/accountFallback.js';

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
  draining = false, now = Date.now() } = {}) {
  if (strictPreferredConnection && connection.id !== preferredConnectionId) return 'strict-account-mismatch';
  if (excluded) return 'request-excluded';
  if (!accountSupportsModel(connection, model)) return 'account-model-excluded';
  if (disabled) return 'model-disabled';
  if (draining) return 'account-draining';
  // The PROVIDER's own reading that this model's window is spent, which is a
  // fact about the account rather than a penalty we imposed. Our timed
  // `modelLock_*` records deliberately do NOT gate admission: an account that
  // just failed stays in the pool and the request moves to the next one, so a
  // failure can never empty the eligible set and strand the caller behind a
  // cooldown it has to wait out.
  if (getExhaustedQuotaWindow(connection, model, now)) return 'quota-exhausted';
  return null;
}
