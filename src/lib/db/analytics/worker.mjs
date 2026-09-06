import { parentPort, workerData } from "node:worker_threads";
import { openAnalyticsReadOnly } from "./readOnly.mjs";
import { validateAnalyticsQuery, readContextOverview, readContextSession } from "./contextQueries.mjs";
import { validateActivityQuery, readActivityAnalytics } from "./activityQueries.mjs";
import { validateQuotaHistoryQuery, readQuotaHistory, readQuotaHistorySummary } from "./quotaHistoryQueries.mjs";
import { analyticsDiagnostic } from "./diagnostics.mjs";

// The message boundary accepts named projections only, never SQL or a DB path.
parentPort?.on("message", async ({ id, query }) => {
  let db;
  let phase = "validate";
  try {
    const validated = query?.operation === "activity" ? validateActivityQuery(query)
      : query?.operation?.startsWith("quota-history") ? validateQuotaHistoryQuery(query) : validateAnalyticsQuery(query);
    phase = "open";
    db = await openAnalyticsReadOnly(workerData.file, workerData.driver);
    const snapshotStartedAt = new Date().toISOString();
    phase = "snapshot";
    db.exec("BEGIN");
    phase = "query";
    const result = validated.operation === "quota-history" ? readQuotaHistory(db, validated)
      : validated.operation === "quota-history-summary" ? readQuotaHistorySummary(db)
      : validated.operation === "activity" ? readActivityAnalytics(db, validated)
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
