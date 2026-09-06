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

// The message boundary accepts named projections only, never SQL or a DB path.
parentPort?.on("message", async ({ id, query }) => {
  let db;
  let phase = "validate";
  try {
    const validated = query?.operation === "evidence" ? validateEvidenceQuery(query)
      : query?.operation === "quota-workbench" ? validateQuotaWorkbenchQuery(query)
      : query?.operation === "key-usage" ? validateKeyUsageQuery(query)
      : query?.operation === "operation-events" ? validateOperationEventsQuery(query)
      : query?.operation === "activity" ? validateActivityQuery(query)
      : query?.operation === "events" ? validateContextEventQuery(query)
      : query?.operation?.startsWith("quota-history") ? validateQuotaHistoryQuery(query) : validateAnalyticsQuery(query);
    phase = "open";
    db = await openAnalyticsReadOnly(workerData.file, workerData.driver);
    const snapshotStartedAt = new Date().toISOString();
    phase = "snapshot";
    db.exec("BEGIN");
    phase = "query";
    const result = validated.operation === "evidence" ? readEvidence(db,validated)
      : validated.operation === "quota-workbench" ? readQuotaWorkbench(db,validated)
      : validated.operation === "key-usage" ? readKeyUsage(db)
      : validated.operation === "operation-events" ? readOperationEvents(db, validated)
      : validated.operation === "quota-history" ? readQuotaHistory(db, validated)
      : validated.operation === "quota-history-summary" ? readQuotaHistorySummary(db)
      : validated.operation === "activity" ? readActivityAnalytics(db, validated)
      : validated.operation === "events" ? readContextEvents(db, validated.filter)
      : validated.operation === "overview" ? readContextOverview(db, validated.filter, validated.retainedDays)
        : readContextSession(db, validated.sessionId, validated.filter);
    phase = "release";
    db.exec("ROLLBACK");
    if (result) result.freshness = { source: db.source, snapshotStartedAt,
      snapshotCompletedAt: new Date().toISOString(), persistedAt: db.persistedAt };
    parentPort.postMessage({ id, result });
  } catch (error) {
    console.warn("[analytics] Read failed", analyticsDiagnostic(error, { operation: query?.operation, phase }));
    parentPort.postMessage({ id, error: "Context analytics is temporarily unavailable." });
  } finally {
    try { db?.close(); }
    catch (error) { console.warn("[analytics] Read failed", analyticsDiagnostic(error,{operation:query?.operation,phase:"close"})); }
  }
});
