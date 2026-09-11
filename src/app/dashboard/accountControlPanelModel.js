import { captureAccountControls } from '@/shared/utils/accountControls';
import { getPausedWindow } from '@/shared/utils/quotaPause';

const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
export const accountControlId = account => account.connectionId || account.id;

export function accountWindows(account) {
  const snapshots = Array.isArray(account.lastQuotaSnapshot?.windows) ? account.lastQuotaSnapshot.windows : [];
  const admin = Array.isArray(account.windows) ? account.windows : [];
  const thresholds = account.quotaPauseThresholds || {};
  const keys = [...new Set([...admin.map(window => window.scope), ...snapshots.map(window => window.key), ...Object.keys(thresholds)].filter(key => typeof key === 'string' && key))];
  return keys.map(key => {
    const stored = snapshots.find(window => window.key === key);
    const projected = admin.find(window => window.scope === key);
    const snapshotTime = Date.parse(account.lastQuotaSnapshot?.fetchedAt);
    const projectedTime = Date.parse(projected?.percentage?.observedAt || projected?.observedAt);
    const useStored = stored && (!Number.isFinite(projectedTime) || Number.isFinite(snapshotTime) && snapshotTime >= projectedTime);
    return {
      key, remaining: percentage(useStored ? stored.remainingPercentage : projected?.percentage?.value),
      unlimited: useStored ? stored?.unlimited === true : projected?.unlimited === true,
      resetAt: useStored ? stored.resetAt : projected?.percentage?.resetAt || projected?.resetAt,
      observedAt: useStored ? account.lastQuotaSnapshot?.fetchedAt : projected?.percentage?.observedAt || projected?.observedAt,
      threshold: percentage(thresholds[key]) || 0,
    };
  });
}

export function mergeAccountControls(connections, rows) {
  const configured = Array.isArray(connections) ? connections : [];
  const health = new Map(rows.map(row => [accountControlId(row), row]));
  const accounts = configured.map(connection => ({ ...health.get(connection.id), ...connection, connectionId: connection.id, displayName: connection.name || connection.displayName || connection.email || health.get(connection.id)?.displayName || connection.id }));
  const known = new Set(accounts.map(accountControlId));
  return [...accounts, ...rows.filter(row => !known.has(accountControlId(row)))].sort((a, b) => String(a.provider || '').localeCompare(String(b.provider || '')) || String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || ''), undefined, { numeric: true }) || accountControlId(a).localeCompare(accountControlId(b), undefined, { numeric: true }));
}

// What switched an account off, read from what actually switched it off.
//
// `isActive === false` alone answered "Paused" for every one of these, and two
// of the three were never the operator's doing. Both automatic writers are in
// src/sse/services/auth.js (:1086 a permanent Codex OAuth failure, :1117 Qoder
// quota exhaustion) and both leave the same three fields behind, which is what
// this reads. The vocabulary is the one the repository already uses for a
// failed connection: src/lib/db/repos/connectionsRepo.js:630 treats error,
// expired and unavailable as degraded, and :650 folds 401 and 403 together as
// an authentication cause.
const REAUTH_STATUS = new Set(['reauth_required', 'expired']);
const FAILED_STATUS = new Set(['unavailable', 'error']);

/**
 * Evidence that something OTHER than the operator turned this account off:
 * 'auth' when the credential itself was rejected, 'error' when the provider
 * refused the account some other way, null when nothing failed.
 *
 * Evidence only. The caller decides whether it is looking at an account that
 * is currently switched off, because a live account can still carry the record
 * of a failure it has since recovered from.
 */
export function accountFailure(account) {
  const code = Number(account.errorCode);
  const failed = Number.isFinite(code) && code > 0;
  if (REAUTH_STATUS.has(account.testStatus) || code === 401) return 'auth';
  if (FAILED_STATUS.has(account.testStatus) || failed) return 'error';
  return null;
}

/**
 * The one state word for an account.
 *
 * Four facts used to share the word "Paused": the operator's own hold, an
 * automatic quota pause, an account the provider refused and disabled, and a
 * row carrying no credential at all. Only the first may say "Paused"; the other
 * three need a different word, and two of them need the operator to act rather
 * than to wait. Credential first, because a row that cannot authenticate cannot
 * serve whatever else is true of it. `hasCredential` is derived server-side in
 * redactConnectionSecrets (src/lib/providerNormalization.js) from the same
 * predicate the gateway admits on; absent (a health row with no matching
 * connection) is not an accusation, so only an explicit false counts.
 */
export function accountControlState(account, now) {
  if (account.hasCredential === false) return 'No credential';
  if (account.isActive === false) {
    const failure = accountFailure(account);
    if (failure === 'auth') return 'Needs sign-in';
    if (failure === 'error') return 'Disabled by error';
    return 'Paused';
  }
  if (getPausedWindow(account, now)) return 'Quota pause';
  if (account.drain?.isDraining || account.isDraining || account.status === 'drained') return 'Draining';
  if (account.status === 'cooldown') return 'Cooldown';
  if (account.status === 'degraded') return 'Needs attention';
  if (account.status === 'unqualified') return 'Not checked';
  if (account.isActive === true) return 'Enabled';
  return 'Unknown';
}

export function accountControlEvidence(account, now) {
  const paused = getPausedWindow(account, now);
  const gates = [];
  if (account.hasCredential === false) gates.push('No credential stored');
  if (account.isActive === false) gates.push(accountFailure(account) ? 'Switched off automatically after a provider failure' : 'Switched off by the operator');
  if (paused) gates.push(`Quota pause at ${paused.remainingPercentage}% remaining in ${paused.key} (threshold ${paused.threshold}%)`);
  if (account.drain?.isDraining || account.isDraining || account.status === 'drained') gates.push('Local drain is on');
  if (account.status === 'cooldown') gates.push('Recorded cooldown');
  const health = account.status === 'healthy' ? 'Recorded status healthy'
    : account.status === 'degraded' ? 'Recorded health needs attention'
      : account.status === 'unqualified' ? 'Qualification not established' : 'Provider health unknown';
  return { health, gates, observedAt: account.lastQualifiedAt || account.lastTestedAt };
}

// How old a reading may be before the board stops calling it current.
export const OBSERVATION_MAX_AGE_MS = 900000;

// Is the OBSERVATION old, missing, or ahead of the clock? The age question on
// its own, with no opinion about the period the reading describes. Split out
// because a replenished window is not an old reading: it is a current reading
// of a period that has since rolled over, and the two need different answers
// (see windowReplenished in accountBoardModel.js).
export function accountWindowObservationStale(window, now) {
  const observedAt = Date.parse(window.observedAt);
  return !Number.isFinite(observedAt) || observedAt > now || now - observedAt > OBSERVATION_MAX_AGE_MS;
}

export function accountWindowStale(window, now) {
  return accountWindowObservationStale(window, now) || Date.parse(window.resetAt) <= now;
}

export function sortAccountControls(accounts, sort, now) {
  const name = account => String(account.displayName || account.name || accountControlId(account));
  // Numeric collation: a plain compare puts spadon+10 ahead of spadon+2.
  const compareName = (a, b) => name(a).localeCompare(name(b), undefined, { numeric: true }) || String(a.provider || '').localeCompare(String(b.provider || '')) || accountControlId(a).localeCompare(accountControlId(b), undefined, { numeric: true });
  const metric = account => {
    const windows = accountWindows(account).filter(window => !window.unlimited && !accountWindowStale(window, now));
    const values = windows.map(window => sort === 'reset' ? Date.parse(window.resetAt) : window.remaining)
      .filter(value => typeof value === 'number' && Number.isFinite(value) && (sort !== 'reset' || value > now));
    return values.length ? Math.min(...values) : Infinity;
  };
  if (sort === 'name') return [...accounts].sort(compareName);
  // Most recorded attempts first; accounts with no activity record go last.
  const activity = account => (Number.isFinite(account.activity?.records) ? -account.activity.records : Infinity);
  const values = new Map(accounts.map(account => [accountControlId(account), sort === 'attempts' ? activity(account) : metric(account)]));
  return [...accounts].sort((a, b) => (values.get(accountControlId(a)) - values.get(accountControlId(b))) || compareName(a, b));
}

export function accountWindowTime(value, now, reset = false) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time <= 0) return { label: reset ? 'Reset unknown' : 'Observation unknown', absolute: null };
  const absolute = new Date(time).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  const minutes = Math.max(0, Math.ceil(Math.abs(time - now) / 60000));
  const duration = minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  return { absolute, label: reset ? time <= now ? 'Reset passed · awaiting update' : `Resets in ${duration}` : time > now ? 'Observation ahead of clock' : `Observed ${duration} ago` };
}

export function accountLimitsPatch(priority, thresholds) {
  if (String(priority).trim() === '' || !Number.isSafeInteger(Number(priority)) || Number(priority) < 1) return null;
  if (Object.values(thresholds).some(value => String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return null;
  return { priority: Number(priority), quotaPauseThresholds: Object.fromEntries(Object.entries(thresholds).map(([key, value]) => [key, Number(value)])) };
}

export function accountControlBaseline(connection, id) {
  if (typeof id !== 'string' || !id || !connection || connection.id !== id || typeof connection.isActive !== 'boolean'
    || connection.priority != null && (!Number.isSafeInteger(connection.priority) || connection.priority < 1)) return null;
  const thresholds = connection.quotaPauseThresholds ?? {};
  if (typeof thresholds !== 'object' || Array.isArray(thresholds)
    || Object.values(thresholds).some(value => percentage(value) === null)) return null;
  return { id, ...captureAccountControls(connection) };
}

export const sameAccountControls = (a, b) => JSON.stringify(captureAccountControls(a)) === JSON.stringify(captureAccountControls(b));

export function makeAccountDraft(before, windows) {
  return { before, priority: before.priority ?? '', thresholds: { ...Object.fromEntries(windows.map(window => [window.key, 0])), ...before.quotaPauseThresholds } };
}

function changedDraftFields(draft) {
  const equal = (value, expected) => value !== '' && Number(value) === expected;
  const priority = draft.before.priority === null ? draft.priority !== '' : !equal(draft.priority, draft.before.priority);
  const keys = [...new Set([...Object.keys(draft.before.quotaPauseThresholds), ...Object.keys(draft.thresholds)])];
  return { priority, thresholds: keys.filter(key => !equal(draft.thresholds[key] ?? 0, draft.before.quotaPauseThresholds[key] ?? 0)) };
}

export function accountDraftState(draft) {
  const changed = changedDraftFields(draft);
  const dirty = changed.priority || changed.thresholds.length > 0;
  const valid = accountLimitsPatch(changed.priority ? draft.priority : 1, draft.thresholds);
  return { dirty, patch: valid ? { ...(changed.priority ? { priority: valid.priority } : {}), ...(changed.thresholds.length ? { quotaPauseThresholds: valid.quotaPauseThresholds } : {}) } : null };
}

export function rebaseAccountDraft(draft, before, windows) {
  const changed = changedDraftFields(draft);
  const current = makeAccountDraft(before, windows);
  return { ...current, priority: changed.priority ? draft.priority : current.priority,
    thresholds: { ...current.thresholds, ...Object.fromEntries(changed.thresholds.map(key => [key, draft.thresholds[key] ?? 0])) } };
}

const failure = (body, status) => typeof body?.error === 'string' ? body.error : body?.error?.message || `Account settings unavailable (${status})`;
export async function readAccountControls(id, request = fetch) {
  const response = await request(`/api/providers/${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok || body?.connection?.id !== id) throw new Error(failure(body, response.status));
  return body.connection;
}

export async function saveAccountControls(before, patch, request = fetch) {
  const id = before.id;
  try {
    const response = await request(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...patch, expectedControls: captureAccountControls(before) }), signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) return { confirmed: false, conflict: response.status === 409, message: response.status === 409 ? 'Account settings changed. Your draft is retained. Read current settings before reviewing it again.' : failure(body, response.status) };
    const current = await readAccountControls(id, request);
    const thresholds = Object.hasOwn(patch, 'quotaPauseThresholds') ? Object.fromEntries(Object.entries(patch.quotaPauseThresholds).filter(([, value]) => value > 0)) : before.quotaPauseThresholds;
    const expected = captureAccountControls({ ...before, ...patch, quotaPauseThresholds: thresholds, priority: body?.connection?.priority });
    const priorityValid = !Object.hasOwn(patch, 'priority') || Number.isSafeInteger(body?.connection?.priority) && body.connection.priority >= 1;
    const confirmed = priorityValid && response.status !== 207 && body?.connection?.id === id && JSON.stringify(captureAccountControls(current)) === JSON.stringify(expected) && JSON.stringify(captureAccountControls(body.connection)) === JSON.stringify(expected);
    return { confirmed, current, message: confirmed ? 'Account settings saved and verified.' : 'Save returned, but the expected account settings could not be verified. Read current settings before another change.' };
  } catch (error) { return { confirmed: false, message: `Save outcome unknown. Read current settings before another change. ${error.message}` }; }
}
