// Presentation helpers for the notification rules surface. Formatting only:
// nothing here decides whether a rule fires, and nothing invents a value that
// the evidence did not carry.

// An unknown is drawn as an explicit word, never as a zero or a dash that
// reads like a measurement.
export const UNKNOWN = 'Not recorded';

export function ruleTimestamp(value) {
  if (!value) return UNKNOWN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return UNKNOWN;
  return new Date(parsed).toISOString().replace('T', ' ').replace('.000Z', '');
}

export function ruleNumber(value, { digits = 2 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN;
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

// Durations are entered in seconds and read in whatever unit keeps them short.
export function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return UNKNOWN;
  const units = [
    ['d', 86_400],
    ['h', 3_600],
    ['min', 60],
  ];
  for (const [suffix, size] of units) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size} ${suffix}`;
  }
  return `${seconds} s`;
}

export function scopeLabel(rule) {
  if (rule.scopeKind === 'global') return 'Every subject';
  return `${rule.scopeKind === 'connection' ? 'Account' : 'Provider'} ${rule.scopeId}`;
}

// The sentence an operator reads instead of decoding four columns. Uses the
// condition's own declared unit and duration role, so a new condition
// describes itself without this function learning about it.
export function ruleSentence(rule, condition) {
  if (!condition) return 'This condition is not available in this build.';
  const comparison = condition.direction === 'below' ? 'at or below' : 'at or above';
  const held =
    condition.durationRole === 'window'
      ? `within ${humanDuration(rule.durationSeconds)}`
      : `for ${humanDuration(rule.durationSeconds)}`;
  return `Notify when ${condition.label.toLowerCase()} is ${comparison} ${ruleNumber(rule.threshold)} ${condition.unit} ${held}, at most once per ${humanDuration(rule.cooldownSeconds)}.`;
}

// The alert's state as one word, from the two columns that carry it. Snooze is
// a suppression, not a resolution, so it never reads as closed.
export function alertState(event, { now = Date.now() } = {}) {
  if (event.outcome === 'acknowledged') return 'acknowledged';
  const until = event.snoozedUntil ? Date.parse(event.snoozedUntil) : null;
  if (Number.isFinite(until) && until > now) return 'snoozed';
  return 'firing';
}

export const ALERT_STATE_LABEL = {
  firing: 'Firing',
  snoozed: 'Snoozed',
  acknowledged: 'Acknowledged',
};

// Where a piece of evidence can be inspected. Each alert's evidence kind maps
// to the workspace surface that already renders those records, so a triggering
// record is reachable rather than merely named.
export function evidenceHref(kind, ref, event) {
  if (!ref) return null;
  if (kind === 'compatibilityComparison') {
    try {
      const [previous, current, check] = JSON.parse(ref);
      const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
      if (!uuid.test(previous) || !uuid.test(current) || typeof check !== 'string' || !check || check.length > 256) return null;
      return `/dashboard/compatibility?${new URLSearchParams({ runId: current, compareRunId: previous, checkId: check })}`;
    } catch { return null; }
  }
  if (kind === 'contextStage') {
    try {
      const [id, ordinal, sessionId] = JSON.parse(ref);
      if (typeof id !== 'string' || !id || !Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(sessionId) || sessionId < 1) return null;
      return `/dashboard/context?${new URLSearchParams({ selected: JSON.stringify({ kind: 'context-attempt', id, sessionId }) })}`;
    } catch { return null; }
  }
  const connectionId = String(event?.scopeKey || '').split('::')[0];
  // Only routes that exist, with the scope param WorkspaceProvider reads.
  // A link to a surface this build does not ship is worse than no link: it
  // presents evidence as reachable and then 404s.
  if ((kind === 'quotaObservation' || kind === 'accountSwitch') && connectionId) {
    return `/dashboard?connectionId=${encodeURIComponent(connectionId)}`;
  }
  if (kind === 'accountSwitch') return '/dashboard/sessions';
  if (kind === 'operationEvent' && /^[1-9]\d*$/.test(String(ref)) && Number.isSafeInteger(Number(ref))) {
    return `/dashboard/operations?${new URLSearchParams({ eventId: String(ref), event: String(ref), start: '1970-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.999Z' })}`;
  }
  return null;
}

export const EVIDENCE_LABEL = {
  compatibilityComparison: 'compatibility check comparison',
  contextStage: 'failed transformation stage',
  quotaObservation: 'quota observation',
  accountSwitch: 'account switch receipt',
  operationEvent: 'operation event',
};

// A dry run reports one of these per scope key. The wording is deliberately
// about EVIDENCE rather than about health: "no firing" is not "healthy".
export const DRY_RUN_STATE_EXPLANATION = {
  fired: 'This rule would have alerted on the retained records listed below.',
  not_fired: 'No retained record sustained this condition for the full duration.',
  no_observation:
    'No measurement was retained for this subject, so staleness cannot be established either way.',
  fresh_enough: 'The newest retained observation is within the staleness threshold.',
  stale: 'The newest retained observation is older than the threshold.',
  cooldown: 'A firing was suppressed by the cooldown.',
};

export const DEFAULT_RULE = Object.freeze({
  name: '',
  conditionKind: 'quota_risk',
  scopeKind: 'global',
  scopeId: '',
  threshold: 10,
  durationSeconds: 900,
  cooldownSeconds: 3600,
  enabled: true,
});

// The board's population is the rules. Every rule sits in exactly one bucket,
// and each bucket is also the summary chip that filters to it.
export const RULE_BUCKETS = [
  { id: 'firing', label: 'Firing', tone: 'refusal' },
  { id: 'enabled', label: 'Enabled', tone: 'positive' },
  { id: 'disabled', label: 'Disabled', tone: null },
];

export const RULE_STATE_WORD = {
  firing: 'Firing',
  enabled: 'Watching',
  disabled: 'Paused',
};

// A rule with an open alert reads as firing, because that is what an operator
// acts on first. A disabled rule never reads as firing: it is not watching.
export function ruleBucket(rule, events = []) {
  if (!rule?.enabled) return 'disabled';
  const open = events.some(
    (event) => event.ruleId === rule.id && alertState(event) === 'firing'
  );
  return open ? 'firing' : 'enabled';
}

export function ruleStateWord(rule, events) {
  return RULE_STATE_WORD[ruleBucket(rule, events)];
}

export function ruleSummary(rules = [], events = []) {
  const counts = { firing: 0, enabled: 0, disabled: 0 };
  for (const rule of rules) counts[ruleBucket(rule, events)] += 1;
  return counts;
}

export const RULE_SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'state', label: 'Firing first' },
  { value: 'threshold', label: 'Highest threshold' },
  { value: 'changed', label: 'Recently changed' },
];

export function filterRules(rules = [], { query = '', bucket = null, kind = null } = {}, { conditions = [], events = [] } = {}) {
  const needle = query.trim().toLowerCase();
  return rules.filter((rule) => {
    if (bucket && ruleBucket(rule, events) !== bucket) return false;
    if (kind && rule.conditionKind !== kind) return false;
    if (!needle) return true;
    const label = conditions.find((entry) => entry.kind === rule.conditionKind)?.label;
    return [rule.name, label || rule.conditionKind, scopeLabel(rule)]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(needle));
  });
}

const ORDER = { firing: 0, enabled: 1, disabled: 2 };

export function sortRules(rules = [], sort = 'name', events = []) {
  const by = {
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    state: (a, b) =>
      ORDER[ruleBucket(a, events)] - ORDER[ruleBucket(b, events)] ||
      String(a.name || '').localeCompare(String(b.name || '')),
    threshold: (a, b) => (Number(b.threshold) || 0) - (Number(a.threshold) || 0),
    changed: (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  };
  return [...rules].sort(by[sort] || by.name);
}

// Alerts carry their own three states, so they group the same way rules do.
export const ALERT_BUCKETS = [
  { id: 'firing', label: 'Firing', tone: 'refusal' },
  { id: 'snoozed', label: 'Snoozed', tone: 'ember' },
  { id: 'acknowledged', label: 'Acknowledged', tone: null },
];

export function alertSummary(events = [], { now = Date.now() } = {}) {
  const counts = { firing: 0, snoozed: 0, acknowledged: 0 };
  for (const event of events) counts[alertState(event, { now })] += 1;
  return counts;
}

// The body a PUT needs: the whole definition plus the revision that was read,
// so a single edited field never drops the rest of the rule.
export function ruleWrite(rule, patch = {}) {
  const next = { ...rule, ...patch };
  return {
    name: next.name,
    conditionKind: next.conditionKind,
    scopeKind: next.scopeKind,
    scopeId: next.scopeKind === 'global' ? null : next.scopeId,
    threshold: Number(next.threshold),
    durationSeconds: Number(next.durationSeconds),
    cooldownSeconds: Number(next.cooldownSeconds),
    enabled: Boolean(next.enabled),
    revision: rule.revision,
  };
}
