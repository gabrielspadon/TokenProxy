import { widestOf, windowMeter } from '@/shared/workspace/windowMeter';
import { overrideCandidates, resolveWindowOverride } from './contextModel';

export { windowMeter };

// One board, three states. A model whose window comes from a saved key is
// overridden; one that answers from the catalog is a registered default; one
// with no positive limit is unknown and is what an operator has to fix.
export const BUCKETS = [
  { id: 'override', label: 'Overridden', tone: 'positive' },
  { id: 'registered', label: 'Registered default', tone: null },
  { id: 'unknown', label: 'Unknown limit', tone: 'ember' },
];

export const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'largest', label: 'Largest window' },
  { value: 'smallest', label: 'Smallest window' },
  { value: 'override', label: 'Overridden first' },
];

const known = (value) => Number.isFinite(value) && value > 0;
export const identity = (row) => `${row.provider}/${row.model}`;

// Catalog models first, then every saved key no catalog model resolves to, so a
// wildcard rule with nothing behind it is still visible and still removable.
export function contextEntries(models = [], overrides = {}) {
  const rows = models.map((row) => {
    const winner = resolveWindowOverride(overrides, row.provider, row.model);
    return {
      kind: 'model',
      id: `model:${identity(row)}`,
      key: identity(row),
      editKey: winner?.key || overrideCandidates(row.provider, row.model)[0].key,
      name: row.name || row.model,
      provider: row.provider,
      providerName: row.providerName || row.provider,
      connections: row.providerConnections,
      catalog: row.staticContextWindow,
      effective: row.contextWindow,
      winner,
      saved: winner ? overrides[winner.key] : undefined,
      row,
    };
  });
  const resolved = new Set(rows.map((row) => row.winner?.key).filter(Boolean));
  const orphans = Object.keys(overrides)
    .filter((key) => !resolved.has(key))
    .map((key) => ({
      kind: 'override',
      id: `override:${key}`,
      key,
      editKey: key,
      name: key,
      provider: null,
      providerName: key.includes('*') ? 'Saved wildcard rule' : 'Saved exact key',
      catalog: null,
      effective: overrides[key],
      winner: { key, scope: key.includes('*') ? 'Saved wildcard rule' : 'Saved exact key' },
      saved: overrides[key],
    }));
  return [...rows, ...orphans];
}

export function contextBucket(entry) {
  if (!known(entry.effective)) return 'unknown';
  return entry.winner ? 'override' : 'registered';
}

export function contextSummary(entries) {
  const summary = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const entry of entries) summary[contextBucket(entry)] += 1;
  return summary;
}

export function filterContext(entries, { query = '', bucket = null } = {}) {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (!bucket || contextBucket(entry) === bucket) &&
      (!needle ||
        `${entry.name} ${entry.key} ${entry.providerName} ${entry.winner?.key || ''}`
          .toLowerCase()
          .includes(needle))
  );
}

export function sortContext(entries, sort = 'name') {
  const size = (entry) => (known(entry.effective) ? entry.effective : -1);
  const byName = (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  return [...entries].sort((a, b) => {
    if (sort === 'largest') return size(b) - size(a) || byName(a, b);
    if (sort === 'smallest') return size(a) - size(b) || byName(a, b);
    if (sort === 'override')
      return Number(Boolean(b.winner)) - Number(Boolean(a.winner)) || byName(a, b);
    return byName(a, b);
  });
}

export const widestWindow = (entries) => widestOf(entries.map((entry) => entry.effective));
