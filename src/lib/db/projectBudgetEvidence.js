import { randomUUID } from 'node:crypto';
import { BUDGET_DIMENSIONS, budgetAmount } from './budgetPolicy.js';
import { captureNotificationTargets } from '../notifications/outbox.mjs';
import { materializeProjectNotification } from '../notifications/projectRecovery.mjs';

const HOUR = 3_600_000;
export function recordProjectBudgetHour(db, { projectId, usageRowId, values, recordedValues, previous }) {
  if (!projectId) return;
  const usage = db.get('SELECT timestamp FROM usageHistory WHERE id=?', [usageRowId]);
  const at = Date.parse(usage?.timestamp);
  if (!Number.isFinite(at)) return;
  const hour = new Date(Math.floor(at / HOUR) * HOUR).toISOString();
  const oldRecorded = previous ? [previous.promptTokens, previous.completionTokens, previous.cost] : [];
  const oldValues = previous ? [previous.actualPromptTokens, previous.actualCompletionTokens, previous.actualCostUsd] : [];
  const delta = recordedValues.map((value, index) => (budgetAmount(value) ?? 0) - (budgetAmount(oldRecorded[index]) ?? 0));
  db.run(`INSERT INTO projectBudgetUsageHours(projectId,hour,records,promptTokens,completionTokens,costUsd,knownCostRecords,unknownPromptRows,unknownCompletionRows,historyThroughId)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,hour) DO UPDATE SET records=records+excluded.records,
      promptTokens=promptTokens+excluded.promptTokens,completionTokens=completionTokens+excluded.completionTokens,
      costUsd=costUsd+excluded.costUsd,knownCostRecords=knownCostRecords+excluded.knownCostRecords,
      unknownPromptRows=unknownPromptRows+excluded.unknownPromptRows,unknownCompletionRows=unknownCompletionRows+excluded.unknownCompletionRows,
      historyThroughId=MAX(historyThroughId,excluded.historyThroughId)`,
  [projectId, hour, previous ? 0 : 1, ...delta, (values[2] !== null ? 1 : 0) - (previous && oldValues[2] !== null ? 1 : 0),
    (values[0] === null ? 1 : 0) - (previous && oldValues[0] === null ? 1 : 0),
    (values[1] === null ? 1 : 0) - (previous && oldValues[1] === null ? 1 : 0), usageRowId]);
}

// A local notification receipt, never a provider call or a remediation action.
export function recordProjectBudgetAlert(db, projectId, at = new Date().toISOString()) {
  const project = db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project || project.archived || project.alertPercent == null) return null;
  const account = db.get('SELECT * FROM projectBudgetAccounts WHERE projectId=?', [projectId]);
  if (!account) return null;
  const dimensions = BUDGET_DIMENSIONS.flatMap(([dimension, limit, column, unknown]) => {
    if (project[limit] == null || account[unknown] > 0) return [];
    const used = account[`recorded${column}`];
    const percentage = project[limit] === 0 ? (used > 0 ? 100 : 0) : used / project[limit] * 100;
    return percentage >= project.alertPercent ? [{ dimension, used, limit: project[limit], percentage }] : [];
  });
  if (!dimensions.length) return null;
  const previous = db.get('SELECT firedAt FROM projectBudgetAlerts WHERE projectId=? ORDER BY firedAt DESC,id DESC LIMIT 1', [projectId]);
  if (previous && Date.parse(at) - Date.parse(previous.firedAt) < project.alertCooldownSeconds * 1000) return null;
  const evidence = { source: 'projectBudgetAccounts', basis: 'lifetime-recorded-application-ledger',
    providerChargeConfirmed: false, dimensions, historyThroughId: account.historyThroughId,
    contributingRecords: { projectId, throughUsageId: account.historyThroughId } };
  const event = { id: randomUUID(), projectId, policyRevision: project.revision, firedAt: at, evidence };
  let targets = null;
  try {
    targets = JSON.stringify(captureNotificationTargets(db, 'project.budget.alert'));
  } catch { /* Unknown event-time authorization must never be reconstructed later. */ }
  db.run(`INSERT INTO projectBudgetAlerts(id,projectId,policyRevision,firedAt,evidence,
    notificationTargets,notificationRetryAt,notificationErrorCode) VALUES(?,?,?,?,?,?,?,?)`,
  [event.id, projectId, event.policyRevision, at, JSON.stringify(evidence), targets,
    targets === null ? null : at, targets === null ? 'event-time-authorization-unavailable' : null]);
  if (targets !== null) materializeProjectNotification(db, { ...event, notificationTargets: targets }, at);
  return event;
}

export function projectSpendingForecast(project, account, hours, asOf = Date.now()) {
  const end = Math.floor(asOf / HOUR) * HOUR;
  const initializedAt = Date.parse(account?.initializedAt);
  const firstCompleteHour = Math.max(end - 24 * HOUR, Math.ceil(initializedAt / HOUR) * HOUR);
  const start = firstCompleteHour < end ? firstCompleteHour : NaN;
  const elapsedHours = Number.isFinite(start) ? Math.max(0, (end - start) / HOUR) : 0;
  const selected = hours.filter(row => Date.parse(row.hour) >= start && Date.parse(row.hour) < end);
  const records = selected.reduce((sum, row) => sum + row.records, 0);
  const knownCostRecords = selected.reduce((sum, row) => sum + row.knownCostRecords, 0);
  const base = { available: false, source: 'transaction-maintained-project-hourly-ledger',
    timeRange: { start: Number.isFinite(start) ? new Date(start).toISOString() : null, end: new Date(end).toISOString() },
    completeHours: elapsedHours, records, knownCostRecords, providerChargeConfirmed: false,
    assumption: 'The next 24 hours repeat the recorded mean hourly workload and applicable recorded application prices. Future routing, quota, rate and workload changes are not predicted.',
    uncertainty: 'Observed hourly range is a scenario range, not a confidence interval or a billing guarantee.' };
  if (elapsedHours < 3 || records < 6) return { ...base, reason: 'insufficient-complete-hour-evidence' };
  if (knownCostRecords !== records) return { ...base, reason: 'incomplete-cost-coverage' };
  const rates = new Map(selected.map(row => [Date.parse(row.hour), row.costUsd]));
  const observed = Array.from({ length: elapsedHours }, (_, index) => rates.get(start + index * HOUR) ?? 0);
  const mean = observed.reduce((sum, value) => sum + value, 0) / elapsedHours;
  const remaining = project.maxCostUsd == null || !account || account.unknownCostRows > 0 ? null : Math.max(0, project.maxCostUsd - account.recordedCostUsd);
  return { ...base, available: true, reason: null, meanUsdPerHour: mean, forecast24HoursUsd: mean * 24,
    observedHourlyRangeUsd: [Math.min(...observed), Math.max(...observed)],
    recordedCostLimitHorizonReason: account?.unknownCostRows > 0 ? 'lifetime-cost-coverage-incomplete' : remaining === null ? 'no-recorded-cost-ceiling' : mean <= 0 ? 'no-positive-observed-rate' : null,
    hoursToRecordedCostLimit: remaining === null || mean <= 0 ? null : remaining / mean };
}
