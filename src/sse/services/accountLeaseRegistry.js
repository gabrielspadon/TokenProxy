/**
 * The process-wide admission registry, and the two ways a request gives a slot
 * back.
 *
 * SEPARATE FROM auth.js ON PURPOSE. Every handler that selects an account must
 * also release its lease, so `releaseAccountLease` is imported by twelve call
 * sites while `getProviderCredentials` is the only thing they want from
 * auth.js. Living in auth.js, the release helpers turned every partial
 * `vi.mock('@/sse/services/auth.js')` in the suite into a hard failure ("No
 * releaseAccountLease export is defined on the mock"): a test that mocks the
 * selection it is not testing does not thereby opt out of the lease lifecycle
 * the handler now runs. A dedicated module is what lets a handler test mock
 * selection and still run the real, cheap, side-effect-free release path.
 */

import { resourceAdmission, releaseOnResponse } from './resourceAdmission.js';
import { createLeaseRegistry } from '@/shared/utils/accountLease.js';

/**
 * ONE lease registry for the whole process, keyed by connection id.
 *
 * Per-connection capacity is a property of the ACCOUNT, not of one request, so
 * a registry per call would count every request as the only one in flight and
 * admit past the ceiling on the first burst - which is the over-admission
 * Account Scheduling Contract rule 6 exists to prevent. Module scope is what
 * makes the count real.
 *
 * `capacityOf` is re-read on every acquire by accountLease.js, so the map below
 * only has to stay current; a live capacity change takes effect without
 * rebuilding anything.
 */
// Sentinel for a connection this process has not seen configured yet. Failing
// OPEN here matches accountCapacity.js: an unknown ceiling must not throttle an
// account to zero, and the connection's real capacity is registered the moment
// it becomes a selection candidate.
const UNGATED_CAPACITY = 0;

const capacityByConnection = new Map();

const accountRegistry = createLeaseRegistry({
  capacityOf: (connectionId) => capacityByConnection.get(connectionId) ?? UNGATED_CAPACITY,
});

const providerByConnection = new Map();
const providerPermits = new WeakMap();
const providerRefusals = new Map();
const providerOnlyLeases = new WeakSet();
export function reserveProviderLease(provider, limit) {
  const permit = resourceAdmission.reserveProvider(provider, limit);
  if (!permit) return null;
  const lease = Object.freeze({ provider });
  providerOnlyLeases.add(lease); providerPermits.set(lease, permit);
  return lease;
}
export const leaseRegistry = {
  ...accountRegistry,
  reserve(connectionId) {
    const metadata = providerByConnection.get(connectionId);
    const permit = metadata ? resourceAdmission.reserveProvider(metadata.provider, metadata.limit) : null;
    if (metadata && !permit) {
      const state = resourceAdmission.snapshot().providers[metadata.provider];
      providerRefusals.set(connectionId, { held: state.active, cap: state.effectiveLimit, retryAfterMs: 1000, scope: 'provider' });
      return null;
    }
    providerRefusals.delete(connectionId);
    const lease = accountRegistry.reserve(connectionId);
    if (!lease) { permit?.release(); return null; }
    if (permit) providerPermits.set(lease, permit);
    return lease;
  },
  lastRefusal(connectionId) { return providerRefusals.get(connectionId) ?? accountRegistry.lastRefusal(connectionId); },
  release(lease) {
    const freed = providerOnlyLeases.delete(lease) || accountRegistry.release(lease);
    if (freed) { providerPermits.get(lease)?.release(); providerPermits.delete(lease); }
    return freed;
  },
};

/** Record what a candidate's ceiling is, before anything reserves against it. */
export function registerAccountCapacity(connectionId, limit, provider = null, providerLimit = null) {
  if (provider) providerByConnection.set(connectionId, { provider, limit: providerLimit });
  capacityByConnection.set(connectionId, limit);
}

/** The registry the request path holds leases in. Exported for the wiring test. */
export function _getLeaseRegistry() {
  return leaseRegistry;
}

/**
 * The most recent reserve refusal for `connectionId`: {held, cap,
 * retryAfterMs} or null. What a LEASE.refused line prints (row 37). A lease
 * object itself already carries `seq` (what LEASE.double-release prints,
 * row 39) and, when admitted without a ceiling, `ungated` + `why` +
 * `held` (what LEASE.ungated prints, row 38).
 */
export function lastLeaseRefusal(connectionId) {
  return leaseRegistry.lastRefusal(connectionId);
}

/**
 * Release a lease taken by getProviderCredentials.
 *
 * IDEMPOTENT by construction (accountLease.js release returns true only for the
 * call that actually freed), so a caller may release on every exit path plus a
 * belt-and-braces `finally` without freeing another request's slot.
 *
 * @returns {boolean} true only for the call that actually freed a slot.
 */
export function releaseAccountLease(lease) {
  return leaseRegistry.release(lease);
}

/**
 * Hand a lease's ownership to the response body, so the slot is held until the
 * client has actually finished reading.
 *
 * A streaming chat answer returns from the handler in milliseconds and then
 * streams for minutes. Releasing at `return` would report the account idle for
 * the whole of that, which is precisely the over-admission rule 6 exists to
 * prevent: the ceiling would be enforced against the handful of requests
 * currently INSIDE the handler rather than the ones actually on the wire.
 *
 * Terminal for every way a body can end - drained (`done`), cancelled by the
 * client disconnecting, or errored mid-stream. A body-less response (a 204, a
 * peeked non-SSE reply) has nothing to wait for and releases now.
 *
 * @returns {Response} the response to hand back, body replaced by the tracked one.
 */
export function releaseAccountLeaseOnResponse(response, lease, signal) {
  if (!lease) return response;
  return releaseOnResponse(response, () => leaseRegistry.release(lease), signal);
}
