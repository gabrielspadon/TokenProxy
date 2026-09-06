import { parentPort, workerData } from "node:worker_threads";
import { openAnalyticsReadOnly } from "./readOnly.mjs";
import { validateAnalyticsQuery, readContextOverview, readContextSession } from "./contextQueries.mjs";

// The message boundary accepts named projections only, never SQL or a DB path.
parentPort?.on("message", async ({ id, query }) => {
  let db;
  try {
    const validated = validateAnalyticsQuery(query);
    db = await openAnalyticsReadOnly(workerData.file, workerData.driver);
    const snapshotStartedAt = new Date().toISOString();
    db.exec("BEGIN");
    const result = validated.operation === "overview"
      ? readContextOverview(db, validated.filter, validated.retainedDays)
      : readContextSession(db, validated.sessionId, validated.filter);
    db.exec("ROLLBACK");
    if (result) result.freshness = { source: db.source, snapshotStartedAt,
      snapshotCompletedAt: new Date().toISOString(), persistedAt: db.persistedAt };
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, error: "Context analytics is temporarily unavailable." });
  } finally { db?.close(); }
});
