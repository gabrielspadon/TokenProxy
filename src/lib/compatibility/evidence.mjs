import { SCOPES, FORMATS } from './model.mjs';
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = value => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function exact(run) {
  const result = run?.result;
  if (!run || !result || typeof result !== 'object' || Array.isArray(result)
    || !text(run.id) || !text(run.fixtureId) || !Number.isSafeInteger(run.fixtureRevision) || run.fixtureRevision < 1
    || !hash(run.fixtureHash) || !hash(result.implementationHash) || !timestamp(run.finishedAt)
    || !SCOPES.includes(run.scope) || !FORMATS.includes(result.sourceFormat) || !FORMATS.includes(result.targetFormat) || !['request','stream'].includes(result.operation)
    || !text(result.model) || !Array.isArray(result.checks) || result.checks.length < 1 || result.checks.length > 256) return false;
  if (run.scope !== 'local-translation' && (![result.provider,result.scenario,result.fixtureVersion].every(text))) return false;
  const ids = new Set();
  for (const check of result.checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.id !== 'string'
      || !/^[A-Za-z0-9_.:-]{1,120}$/.test(check.id) || !['passed','failed','unknown'].includes(check.outcome) || ids.has(check.id)) return false;
    ids.add(check.id);
  }
  if (result.scope !== undefined && result.scope !== run.scope) return false;
  if (run.status === 'succeeded' && result.checks.some(check => check.outcome === 'failed')) return false;
  if (run.status === 'failed' && !result.checks.some(check => check.outcome === 'failed')) return false;
  return true;
}
const identity = run => JSON.stringify([run.fixtureHash, run.scope, run.result?.sourceFormat, run.result?.targetFormat, run.result?.operation, run.result?.provider || null, run.result?.model || null, run.result?.scenario || null, run.result?.fixtureVersion || null]);
export function compareCompatibilityRuns(previous, current) {
  if (!exact(previous) || !exact(current) || previous.id === current.id || !previous.finishedAt || !current.finishedAt || previous.finishedAt > current.finishedAt || identity(previous) !== identity(current) || !['succeeded','failed'].includes(previous.status) || !['succeeded','failed'].includes(current.status)) return { comparable: false, reason: 'Exact fixture, target, scope and completed checks must match. Missing, cancelled, interrupted or timed-out evidence cannot establish regression.', regressions: [] };
  const old = new Map(previous.result.checks.map(check => [check.id, check.outcome]));
  const regressions = current.result.checks.filter(check => check.outcome === 'failed' && old.get(check.id) === 'passed').map(check => ({ checkId: check.id, previousOutcome: 'passed', currentOutcome: 'failed' }));
  return { comparable: true, previousRunId: previous.id, currentRunId: current.id, fixtureId: current.fixtureId, fixtureHash: current.fixtureHash, fixtureRevision: current.fixtureRevision, scope: current.scope,
    provider: current.result.provider || null, model: current.result.model || null, fixtureVersion: current.result.fixtureVersion || null, scenario: current.result.scenario || null,
    previousImplementationHash: previous.result.implementationHash, currentImplementationHash: current.result.implementationHash,
    regressions, evidenceLinks: [previous.id, current.id].map(id => `/api/admin/compatibility/runs/${id}`) };
}
export function qualifiedRegressionEvidence(runs) {
  const previous = new Map(), events = [];
  for (const run of (Array.isArray(runs) ? runs : []).filter(exact).sort((a,b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id))) {
    if (!['succeeded','failed'].includes(run.status)) continue;
    const key = identity(run), baseline = previous.get(key);
    if (baseline) { const comparison = compareCompatibilityRuns(baseline, run); if (comparison.regressions.length) events.push({ ...comparison, occurredAt: run.finishedAt }); }
    previous.set(key, run);
  }
  return events;
}
export function capabilityEvidence(runs) {
  const groups = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    const result = run.result || {}, key = JSON.stringify([identity(run), result.implementationHash || 'unknown']);
    if (!groups.has(key)) groups.set(key, { sourceFormat: result.sourceFormat || run.sourceFormat, targetFormat: result.targetFormat || run.targetFormat, operation: result.operation || run.operation,
      scope: run.scope, provider: result.provider || 'unknown', model: result.model || run.model || 'unknown', scenario: result.scenario || 'custom', fixtureHash: run.fixtureHash, fixtureVersion: result.fixtureVersion || 'local-v1', implementationHash: result.implementationHash || 'unknown',
      runs: 0, passed: 0, failed: 0, other: 0, pending: 0, unknown: 0, lastRunAt: run.createdAt, runIds: [] });
    const row = groups.get(key); row.runs++; row.runIds.push(run.id); if (run.createdAt > row.lastRunAt) row.lastRunAt = run.createdAt;
    if (['queued','running'].includes(run.status)) row.pending++;
    else if (['cancelled','timed-out','interrupted'].includes(run.status)) row.other++;
    else if (!exact(run) || result.checks.some(check => check.outcome === 'unknown')) row.unknown++;
    else if (run.status === 'succeeded' && result.checks.every(check => check.outcome === 'passed')) row.passed++;
    else if (run.status === 'failed' && result.checks.some(check => check.outcome === 'failed')) row.failed++;
    else row.unknown++;
  }
  return [...groups.values()];
}
