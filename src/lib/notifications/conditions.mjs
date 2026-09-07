// The condition catalogue. A condition exists here only when this tree
// actually retains a measurement that answers it. Everything else is listed as
// unavailable, with the reason and the column that would have to exist.
//
// This file is the single source of truth for both halves: the evaluator reads
// CONDITIONS, and the operator surface reads UNAVAILABLE_CONDITIONS so an
// operator sees WHY a condition they might expect is missing rather than
// finding a silently short list.

// `durationRole` says what durationSeconds means for a condition, because the
// two honest readings are not interchangeable:
//   'sustained' — the condition must hold continuously for that long. Measured
//     from consecutive retained samples; a gap in evidence breaks the sustain.
//   'window'    — the condition counts qualifying records inside a trailing
//     window of that length. The count IS the measurement.
export const CONDITIONS = Object.freeze({
  quota_risk: {
    kind: 'quota_risk',
    label: 'Quota headroom below threshold',
    // quotaObservations.remaining / "limit" / percentage, retained per
    // (connection, scope), analysed by analyzeQuotaSeries.
    source: 'quotaObservations',
    durationRole: 'sustained',
    unit: 'percent remaining',
    thresholdRange: [0, 100],
    // Fires when headroom sits AT OR BELOW the threshold.
    direction: 'below',
    scopeKeyKind: 'connection-scope',
    evidenceKind: 'quotaObservation',
    description:
      'Retained quota observations show headroom at or below the threshold for the full duration. Percentage is used when the provider reports one, otherwise remaining over limit.',
  },
  repeated_fallback: {
    kind: 'repeated_fallback',
    label: 'Repeated account fallback',
    // accountSwitches, one append-only receipt per repin.
    source: 'accountSwitches',
    durationRole: 'window',
    unit: 'switches',
    thresholdRange: [1, 1000],
    direction: 'atLeast',
    scopeKeyKind: 'connection',
    evidenceKind: 'accountSwitch',
    // 'initial-pin' and 'first-pin' are a session's first assignment, not a
    // fallback away from anything, so they are excluded from the count.
    excludedTriggers: ['initial-pin', 'first-pin'],
    description:
      'Counts recorded switches away from an account inside the window. A session first pinning to an account is not a fallback and is not counted.',
  },
  stale_telemetry: {
    kind: 'stale_telemetry',
    label: 'Quota telemetry stale',
    // quotaObservations.observedAt age, against the same asOf the workbench
    // uses. The threshold is the operator's own staleness tolerance.
    source: 'quotaObservations',
    durationRole: 'sustained',
    unit: 'minutes since last observation',
    thresholdRange: [1, 20160],
    direction: 'atLeast',
    scopeKeyKind: 'connection-scope',
    evidenceKind: 'quotaObservation',
    description:
      'The newest retained observation for an account window is older than the threshold. Absence of evidence is reported as absence of evidence, never as healthy.',
  },
  operation_failure: {
    kind: 'operation_failure',
    label: 'Operation failures in window',
    // operationEvents terminal states.
    source: 'operationEvents',
    durationRole: 'window',
    unit: 'failed operations',
    thresholdRange: [1, 10000],
    direction: 'atLeast',
    scopeKeyKind: 'connection',
    evidenceKind: 'operationEvent',
    // 'uncertain' is deliberately excluded: an operation that did not resolve
    // is not evidence that it failed, and counting it would inflate the alert.
    countedStates: ['failed'],
    description:
      'Counts operations reaching a failed terminal state inside the window. Cancelled and uncertain operations are not failures and are not counted.',
  },
});

// Listed, not implemented. Each entry names what is missing and what would have
// to be recorded first. These appear in the operator surface so the absence is
// visible and explained rather than merely absent.
export const UNAVAILABLE_CONDITIONS = Object.freeze([
  {
    kind: 'compression_saver_failure',
    label: 'Compression / token-saver failure',
    reason:
      'Failed context reductions cannot currently be distinguished from deliberately skipped reductions in the retained evidence. An unchanged request does not establish whether a reduction failed, so it cannot reliably trigger a failure alert.',
    wouldRequire:
      'A recorded failure outcome for each affected transformation, kept separate from deliberate skips and unchanged results.',
  },
]);

export const CONDITION_KINDS = Object.freeze(Object.keys(CONDITIONS));

export function conditionFor(kind) {
  const condition = CONDITIONS[kind];
  if (!condition) throw new TypeError(`Unsupported condition kind: ${kind}`);
  return condition;
}
