const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

export const TOKEN_COLUMNS = [
  { id: 'inputTokens', samples: 'inputSamples', label: 'Input', detail: 'Cache inclusive', color: '#4d5bb5' },
  { id: 'uncachedInputTokens', samples: 'uncachedInputSamples', label: 'Uncached', detail: 'Derived input', color: '#657391' },
  { id: 'cacheReadTokens', samples: 'cacheReadSamples', label: 'Cache read', detail: 'Recorded tokens', color: '#168a82' },
  { id: 'cacheWriteTokens', samples: 'cacheWriteSamples', label: 'Cache write', detail: 'Recorded tokens', color: '#b47d32' },
  { id: 'outputTokens', samples: 'outputSamples', label: 'Output', detail: 'Recorded tokens', color: '#8a63b7' },
];

export const formatCount = (value) => Number.isFinite(value) ? integer.format(value) : 'Unknown';
export const formatTokens = (value) => Number.isFinite(value) ? compact.format(value) : 'Unknown';
export const formatEstimate = (value) => Number.isFinite(value)
  ? value > 0 && value < 0.0001 ? '<$0.0001' : currency.format(value) : 'Unknown';
export const formatPercent = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value)
  : 'Unknown';

export function groupKey(group, groupBy) {
  return JSON.stringify([groupBy, group.provider ?? null,
    groupBy === 'model' ? group.model ?? null : groupBy === 'account' ? group.connectionId ?? null : null]);
}

export function groupName(group, groupBy, accounts = []) {
  if (groupBy === 'model') return group.model || 'Unspecified model';
  if (groupBy === 'account') {
    const account = accounts.find((item) => (item.id ?? item.connectionId) === group.connectionId);
    return account?.name || account?.label || account?.connectionName
      || (group.connectionId ? `Historical account ${String(group.connectionId).slice(0, 8)}` : 'Unassigned account');
  }
  return group.provider || 'Unspecified provider';
}

export function groupFilters(group, groupBy) {
  if (!group?.provider) return null;
  if (groupBy === 'model') return group.model ? { provider: group.provider, model: group.model } : null;
  if (groupBy === 'account') return group.connectionId ? { provider: group.provider, connectionId: group.connectionId } : null;
  return { provider: group.provider };
}

export function averageEstimate(group) {
  return group.costSamples > 0 && Number.isFinite(group.recordedCostUsd)
    ? group.recordedCostUsd / group.costSamples : null;
}

export function averageTokens(group, column) {
  return group[column.samples] > 0 && Number.isFinite(group[column.id])
    ? group[column.id] / group[column.samples] : null;
}

export function measuredTokens(group, column) {
  return group[column.samples] === 0 ? null : group[column.id];
}

export function costShare(group, summary) {
  return Number.isFinite(group.recordedCostUsd) && summary?.recordedCostUsd > 0
    ? group.recordedCostUsd / summary.recordedCostUsd : null;
}

export function qualityNotes(row, record = false) {
  const notes = [];
  const count = (key, singular) => record ? (row[singular] ? 1 : 0) : row[key] || 0;
  const inconsistent = count('inconsistentCacheRows', 'inconsistentCache');
  const missing = count('missingTokenDetailRows', 'missingTokenDetail');
  const invalid = count('invalidTokenRows', 'invalidTokens');
  if (inconsistent) notes.push(`${formatCount(inconsistent)} ${inconsistent === 1 ? 'record has' : 'records have'} cache reads and writes exceeding stored input. Uncached input is clamped at zero; quantities do not reconcile.`);
  if (missing) notes.push(`${formatCount(missing)} ${missing === 1 ? 'record lacks' : 'records lack'} usable cache detail. Missing detail cannot establish zero cache usage.`);
  if (invalid) notes.push(`${formatCount(invalid)} ${invalid === 1 ? 'record contains' : 'records contain'} invalid token quantities. Unusable values remain unknown and are excluded from the field’s sample count.`);
  if (row.numericOverflowFields?.length) notes.push(`Numeric totals are unavailable for ${row.numericOverflowFields.join(', ')} because they exceed the supported numeric range.`);
  if (!record && row.invalidTimestampRows) notes.push(`${formatCount(row.invalidTimestampRows)} records have invalid timestamps and are absent from the time series.`);
  return notes;
}

export function recordTime(value, full = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Invalid timestamp';
  return full ? date.toISOString() : `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 19)}`;
}
