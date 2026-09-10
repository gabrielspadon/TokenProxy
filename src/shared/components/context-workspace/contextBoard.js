import { IDENTITY, finite } from './contextModel';

// One bucket per recorded identity source, strongest evidence first. The
// wording is IDENTITY's, so the chip, the group and the state word never
// disagree about what a session's identity actually is.
export const IDENTITY_BUCKETS = [
  { id: 'explicit', label: IDENTITY.explicit, tone: 'positive' },
  { id: 'routing', label: IDENTITY.routing, tone: null },
  { id: 'inferred', label: IDENTITY.inferred, tone: 'ember' },
  { id: 'request', label: IDENTITY.request, tone: 'ember' },
];

export const SORTS = [
  { value: 'recent', label: 'Most recent' },
  { value: 'attempts', label: 'Attempts' },
  { value: 'input', label: 'Input tokens' },
  { value: 'name', label: 'Name' },
];

export const sessionBucket = (session) =>
  IDENTITY_BUCKETS.some((bucket) => bucket.id === session?.identitySource)
    ? session.identitySource
    : 'request';

export const sessionWord = (session) =>
  IDENTITY_BUCKETS.find((bucket) => bucket.id === sessionBucket(session)) || IDENTITY_BUCKETS[3];

export const sessionName = (session) =>
  session?.projectLabel || `Session #${session?.id ?? 'unknown'}`;

export function sessionSummary(sessions) {
  const counts = Object.fromEntries(IDENTITY_BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const session of sessions) counts[sessionBucket(session)] += 1;
  return counts;
}

export function filterSessions(sessions, { query, bucket }) {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (bucket && sessionBucket(session) !== bucket) return false;
    if (!needle) return true;
    return [sessionName(session), session.clientTool, `#${session.id}`]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

export function orderSessions(sessions, sort) {
  const number = (value) => (finite(value) ? value : -Infinity);
  const copy = [...sessions];
  if (sort === 'attempts') copy.sort((a, b) => number(b.attempts) - number(a.attempts));
  else if (sort === 'input')
    copy.sort((a, b) => number(b.providerInputTokens) - number(a.providerInputTokens));
  else if (sort === 'name') copy.sort((a, b) => sessionName(a).localeCompare(sessionName(b)));
  else copy.sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0));
  return copy;
}

// A share of the page's own largest value, so a bar reads as "how much of the
// cohort this session carries" rather than as a status meter.
export function shareOf(value, values) {
  const top = Math.max(0, ...values.map((item) => (finite(item) ? Math.abs(item) : 0)));
  return top > 0 && finite(value) ? (Math.abs(value) / top) * 100 : 0;
}
