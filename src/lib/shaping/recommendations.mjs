export function compareEvaluationEvidence(baseline, candidate) {
  const measured = candidate.results.length, matches = baseline.results.length === measured && measured > 0;
  const bad = row => row.stages.some(stage => stage.status === 'error') || !row.validity.toolTransactionsValid || !row.validity.currentPreserved || !row.validity.liveThinkingPreserved || !row.validity.errorEvidencePreserved;
  const failures = candidate.results.filter(bad).length;
  const beforeBytes = baseline.results.reduce((sum, row) => sum + row.afterBytes, 0), afterBytes = candidate.results.reduce((sum, row) => sum + row.afterBytes, 0);
  const same = matches && candidate.results.every((row, i) => row.fixtureId === baseline.results[i].fixtureId && row.afterHash === baseline.results[i].afterHash);
  const disposition = !matches ? 'insufficient-evidence' : failures ? 'reject' : candidate.unsupported.length ? 'incomplete-coverage' : same ? 'equivalent-on-selected-set' : 'review-tradeoffs';
  return { disposition, fixtureCount: measured, failedFixtures: failures, failureRate: measured ? failures / measured : null,
    byteChange: { baseline: beforeBytes, candidate: afterBytes, delta: afterBytes - beforeBytes, unit: 'serialized bytes', denominator: `${measured} selected cases` },
    latency: { baselineMs: baseline.results.reduce((sum, row) => sum + row.latencyMs, 0), candidateMs: candidate.results.reduce((sum, row) => sum + row.latencyMs, 0), samplesPerCase: 1, uncertainty: 'Single local execution per case; timing is descriptive and does not establish a performance improvement.' },
    explanation: disposition === 'reject' ? 'Candidate failed selected integrity checks; promotion is refused.' : disposition === 'equivalent-on-selected-set' ? 'All selected outputs match the baseline. These cases establish no output benefit from the changed settings.' : disposition === 'incomplete-coverage' ? 'Some enabled stages were not evaluated. Review their scope before any activation.' : 'Review the changed outputs and integrity evidence. Fewer bytes alone do not establish a better profile.',
    tokenSavings: null, monetarySavings: null, taskOutcomeChange: null, recommendationToActivate: false,
    limitations: ['No provider calls or task execution occurred.', 'Token counts, charges, task outcomes and cache billing are unmeasured.', 'Observed integrity checks cover the selected cases only.'] };
}
