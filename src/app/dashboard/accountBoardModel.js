import {
  accountControlId,
  accountControlState,
  accountWindowStale,
  accountWindowTime,
  accountWindows,
} from './accountControlPanelModel';
import { groupQuotaProducts } from './quotaProductGroups';

// One glance answers "how many accounts can take work right now". Every account
// lands in exactly one bucket; the order here is the order the strip renders.
export const BUCKETS = [
  { id: 'ready', label: 'Ready', tone: 'positive' },
  { id: 'low', label: 'Low quota', tone: 'ember' },
  { id: 'paused', label: 'Paused', tone: 'slate' },
  { id: 'attention', label: 'Attention', tone: 'refusal' },
  { id: 'unknown', label: 'Unknown', tone: 'slate' },
];

export const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'reset', label: 'Next reset' },
  { value: 'headroom', label: 'Least headroom' },
];

export function liveWindows(account, now) {
  return accountWindows(account).filter(
    (window) =>
      !window.unlimited && Number.isFinite(window.remaining) && !accountWindowStale(window, now)
  );
}

export function accountBucket(account, now) {
  const state = accountControlState(account, now);
  if (state === 'Paused' || state === 'Quota pause') return 'paused';
  if (state === 'Draining' || state === 'Cooldown' || state === 'Needs attention')
    return 'attention';
  if (
    liveWindows(account, now).some((window) => window.remaining <= Math.max(10, window.threshold))
  )
    return 'low';
  return state === 'Unknown' ? 'unknown' : 'ready';
}

// The word beside the dot. Buckets are coarse on purpose; the word keeps the
// specific gate when there is one, so "Draining" and "Cooldown" stay distinct.
export function accountStateWord(account, now) {
  const state = accountControlState(account, now);
  const bucket = accountBucket(account, now);
  if (bucket === 'low') return 'Low quota';
  if (state === 'Needs attention') return 'Attention';
  if (state === 'Enabled' || state === 'Not checked') return 'Ready';
  return state;
}

export function fleetSummary(accounts, now) {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const account of accounts) counts[accountBucket(account, now)] += 1;
  return counts;
}

export function filterAccounts(accounts, { query = '', bucket = null }, now) {
  const needle = query.trim().toLowerCase();
  return accounts.filter(
    (account) =>
      (!bucket || accountBucket(account, now) === bucket) &&
      (!needle ||
        `${account.displayName || account.name || ''} ${account.email || ''} ${account.provider} ${accountControlId(account)}`
          .toLowerCase()
          .includes(needle))
  );
}

// Flat window lines for one row. Product groups (Codex Spark, a Claude model
// allowance) prefix their label so the line still reads on its own.
export function windowLines(account) {
  return groupQuotaProducts(account.provider, accountWindows(account)).flatMap((group) =>
    group.windows.map((window) => ({
      ...window,
      label:
        group.id === 'general' || group.label === window.label
          ? window.label
          : `${group.label} · ${window.label}`,
    }))
  );
}

export function resetShort(window, now) {
  const time = accountWindowTime(window.resetAt, now, true);
  if (!time.absolute) return 'no reset time';
  return time.label.startsWith('Resets in ') ? `resets in ${time.label.slice(10)}` : 'reset passed';
}

export function providerList(accounts) {
  return [...new Set(accounts.map((account) => account.provider).filter(Boolean))].sort();
}

// How a provider entry can be credentialed, derived from the registry entry.
export function credentialModes(entry) {
  if (Array.isArray(entry.authModes) && entry.authModes.length) return entry.authModes;
  const modes = [];
  if (entry.hasOAuth) modes.push('oauth');
  if (entry.noAuth) modes.push('none');
  else if (entry.authType === 'cookie') modes.push('cookie');
  else modes.push('apikey');
  return modes;
}
