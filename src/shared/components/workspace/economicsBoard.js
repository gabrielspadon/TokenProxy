import { ECONOMICS_GROUPS } from '@/lib/db/analytics/economicsDimensions.mjs';
import { providerIdentity } from '../ProviderMark';
import { costShare, groupKey, groupName, qualityNotes } from './economics';

// One bucket per cohort, on the evidence the cohort actually carries. A cohort
// whose token detail needs interpretation is named first because that is the
// thing an operator has to read before trusting any amount below it.
export const BUCKETS = [
  { id: 'priced', label: 'Priced', tone: 'positive' },
  { id: 'partly', label: 'Partly priced', tone: 'ember' },
  { id: 'unpriced', label: 'Unpriced', tone: 'refusal' },
];

export const SORTS = [
  { value: 'cost', label: 'Cost' },
  { value: 'records', label: 'Records' },
  { value: 'tokens', label: 'Input tokens' },
  { value: 'name', label: 'Name' },
];

// A cohort sits in exactly one pricing bucket. Token detail that needs
// interpretation is a separate, cross-cutting fact: it can apply to a priced
// cohort and to an unpriced one alike, so it filters rather than buckets.
export const FLAGGED = 'flagged';

export function cohortBucket(group) {
  const samples = Number.isFinite(group?.costSamples) ? group.costSamples : 0;
  const records = Number.isFinite(group?.records) ? group.records : 0;
  if (!samples) return 'unpriced';
  return records > 0 && samples >= records ? 'priced' : 'partly';
}

export function cohortIssues(group) {
  return qualityNotes(group).length;
}

export function cohortStateWord(group) {
  const bucket = cohortBucket(group);
  return BUCKETS.find((item) => item.id === bucket) || BUCKETS[2];
}

// The kind line under a cohort name: what this identity IS, never a repeat of
// the name itself.
export function cohortKind(group, groupBy) {
  if (groupBy === 'provider') return 'Recorded completion ledger';
  if (group?.provider) return providerIdentity(group.provider).name;
  if (groupBy === 'client-project') return 'Client-reported, installation scoped';
  return (
    ECONOMICS_GROUPS.find((item) => item.value === groupBy)?.label || 'Exact recorded identity'
  );
}

// Shares of the cohort's own recorded input: uncached input, cached reads and
// cache writes. Composition, never status, so it uses the cool metric hues.
export function inputShares(group) {
  const parts = [
    ['input', group?.uncachedInputTokens],
    ['read', group?.cacheReadTokens],
    ['write', group?.cacheWriteTokens],
  ].map(([kind, value]) => [kind, Number.isFinite(value) && value > 0 ? value : 0]);
  const total = parts.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return null;
  return parts.map(([kind, value]) => ({ kind, percent: (value / total) * 100 }));
}

export function cachedShare(group) {
  const read = Number.isFinite(group?.cacheReadTokens) ? group.cacheReadTokens : null;
  const input = Number.isFinite(group?.inputTokens) ? group.inputTokens : null;
  return read !== null && input > 0 ? read / input : null;
}

export function boardSummary(groups) {
  const counts = Object.fromEntries([...BUCKETS.map((bucket) => [bucket.id, 0]), [FLAGGED, 0]]);
  for (const group of groups) {
    counts[cohortBucket(group)] += 1;
    if (cohortIssues(group)) counts[FLAGGED] += 1;
  }
  return counts;
}

export function filterCohorts(groups, { query, bucket }, groupBy, accounts) {
  const needle = query.trim().toLowerCase();
  return groups.filter((group) => {
    if (bucket === FLAGGED ? !cohortIssues(group) : bucket && cohortBucket(group) !== bucket)
      return false;
    if (!needle) return true;
    const name = groupName(group, groupBy, accounts).toLowerCase();
    return (
      name.includes(needle) ||
      String(group.provider || '')
        .toLowerCase()
        .includes(needle)
    );
  });
}

export function orderCohorts(groups, sort, groupBy, accounts, summary) {
  const number = (value) => (Number.isFinite(value) ? value : -Infinity);
  const copy = [...groups];
  if (sort === 'name')
    copy.sort((a, b) =>
      groupName(a, groupBy, accounts).localeCompare(groupName(b, groupBy, accounts))
    );
  else if (sort === 'records') copy.sort((a, b) => number(b.records) - number(a.records));
  else if (sort === 'tokens') copy.sort((a, b) => number(b.inputTokens) - number(a.inputTokens));
  else
    copy.sort(
      (a, b) =>
        number(costShare(b, summary) ?? b.recordedCostUsd) -
        number(costShare(a, summary) ?? a.recordedCostUsd)
    );
  return copy;
}

export const cohortId = (group, groupBy) => groupKey(group, groupBy);
