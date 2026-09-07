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
  return [...accounts, ...rows.filter(row => !known.has(accountControlId(row)))].sort((a, b) => String(a.provider || '').localeCompare(String(b.provider || '')) || String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || '')) || accountControlId(a).localeCompare(accountControlId(b)));
}

export function accountControlState(account, now) {
  if (account.isActive === false) return 'Paused';
  if (getPausedWindow(account, now)) return 'Quota pause';
  if (account.drain?.isDraining || account.isDraining) return 'Draining';
  if (account.status === 'cooldown') return 'Cooldown';
  if (account.status === 'degraded') return 'Needs attention';
  if (account.status === 'unqualified') return 'Not checked';
  if (account.isActive === true) return 'Enabled';
  return 'Unknown';
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
