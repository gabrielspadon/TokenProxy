import { parentPort, workerData } from "node:worker_threads";
import { openAnalyticsReadOnly } from "./readOnly.mjs";
import { validateAnalyticsQuery, readContextOverview, readContextSession } from "./contextQueries.mjs";
import { validateActivityQuery, readActivityAnalytics } from "./activityQueries.mjs";
import { validateQuotaHistoryQuery, readQuotaHistory, readQuotaHistorySummary } from "./quotaHistoryQueries.mjs";
import { validateContextEventQuery, readContextEvents } from "./contextEvents.mjs";
import { analyticsDiagnostic } from "./diagnostics.mjs";
import { validateEvidenceQuery, readEvidence } from "./evidenceQueries.mjs";
import { validateKeyUsageQuery, readKeyUsage } from "./keyUsageQueries.mjs";
import { validateQuotaWorkbenchQuery, readQuotaWorkbench } from "./quotaWorkbenchQueries.mjs";
import { validateOperationEventsQuery, readOperationEvents } from "./operationEventsQueries.mjs";
import { validateSessionPinTimelineQuery, readSessionPinTimeline } from "./sessionPinTimelineQueries.mjs";
import { validateNotificationEvidenceQuery, readNotificationEvidence } from "./notificationRuleQueries.mjs";

let persistentDb;
const lifecycleWaiters = new Map();
function configure(db, persistent) {
  db.exec(persistent
    ? "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-8192; PRAGMA mmap_size=0;"
    : "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64000; PRAGMA mmap_size=30000000;");
  return db;
}
async function acquireDatabase() {
  if (workerData.driver === 'sql.js') return { db: configure(await openAnalyticsReadOnly(workerData.file, workerData.driver), false), transient: true };
  persistentDb ||= configure(await openAnalyticsReadOnly(workerData.file, workerData.driver), true);
  return { db: persistentDb, transient: false };
}
function discardPersistentDatabase() {
  try { persistentDb?.close(); } catch {}
  persistentDb = undefined;
}
parentPort?.on('close', discardPersistentDatabase);

// The message boundary accepts named projections only, never SQL or a DB path.
parentPort?.on("message", async ({ id, query, lifecycle }) => {
  if (lifecycle === 'snapshot-continue') {
    lifecycleWaiters.get(id)?.();
    return;
  }
  let db;
  let transient = false;
  let acquired = false;
  let failed = false;
  let phase = "validate";
  try {
    const validated = query?.operation === "evidence" ? validateEvidenceQuery(query)
      : query?.operation === "quota-workbench" ? validateQuotaWorkbenchQuery(query)
      : query?.operation === "key-usage" ? validateKeyUsageQuery(query)
      : query?.operation === "operation-events" ? validateOperationEventsQuery(query)
      : query?.operation === "session-pin-timeline" ? validateSessionPinTimelineQuery(query)
      : query?.operation === "notification-evidence" ? validateNotificationEvidenceQuery(query)
      : query?.operation === "activity" ? validateActivityQuery(query)
      : query?.operation === "events" ? validateContextEventQuery(query)
      : query?.operation?.startsWith("quota-history") ? validateQuotaHistoryQuery(query) : validateAnalyticsQuery(query);
    phase = "open";
    ({ db, transient } = await acquireDatabase());
    acquired = true;
    const snapshotStartedAt = new Date().toISOString();
    phase = "snapshot";
    db.exec("BEGIN");
    if (workerData.traceLifecycle) {
      db.get('SELECT schema_version FROM pragma_schema_version');
      parentPort.postMessage({ id, lifecycle: 'snapshot-started', snapshotStartedAt });
      await new Promise(resolve => lifecycleWaiters.set(id, resolve));
      lifecycleWaiters.delete(id);
    }
    phase = "query";
    const queryStarted = performance.now();
    const result = validated.operation === "evidence" ? readEvidence(db,validated)
      : validated.operation === "quota-workbench" ? readQuotaWorkbench(db,validated)
      : validated.operation === "key-usage" ? readKeyUsage(db)
      : validated.operation === "operation-events" ? readOperationEvents(db, validated)
      : validated.operation === "session-pin-timeline" ? readSessionPinTimeline(db, validated)
      : validated.operation === "notification-evidence" ? readNotificationEvidence(db, validated)
      : validated.operation === "quota-history" ? readQuotaHistory(db, validated)
      : validated.operation === "quota-history-summary" ? readQuotaHistorySummary(db)
      : validated.operation === "activity" ? readActivityAnalytics(db, validated)
      : validated.operation === "events" ? readContextEvents(db, validated.filter)
      : validated.operation === "overview" ? readContextOverview(db, validated.filter, validated.retainedDays)
        : readContextSession(db, validated.sessionId, validated.filter);
    const queryDurationMs = performance.now() - queryStarted;
    phase = "release";
    db.exec("ROLLBACK");
    if (result) result.freshness = { source: db.source, snapshotStartedAt,
      queryDurationMs,
      snapshotCompletedAt: new Date().toISOString(), persistedAt: db.persistedAt };
    parentPort.postMessage({ id, result });
  } catch (error) {
    failed = true;
    try { db?.exec('ROLLBACK'); } catch {}
    console.warn("[analytics] Read failed", analyticsDiagnostic(error, { operation: query?.operation, phase }));
    parentPort.postMessage({ id, error: "Context analytics is temporarily unavailable." });
  } finally {
    if (transient) {
      try { db?.close(); }
      catch (error) { console.warn("[analytics] Read failed", analyticsDiagnostic(error,{operation:query?.operation,phase:"close"})); }
    } else if (failed && acquired) discardPersistentDatabase();
  }
});
