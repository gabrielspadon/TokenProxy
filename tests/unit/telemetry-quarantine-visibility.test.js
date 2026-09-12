import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { telemetryFilterSql } from "../../src/lib/db/analytics/telemetryFilter.mjs";

// The quarantine predicate is a visibility contract, so these cases pin the
// exact visible set rather than the SQL text. The membership set is built once
// per query instead of once per population row; that is a plan change only and
// every case below must answer identically either way.
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
    CREATE TABLE requestStats(id TEXT PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
    CREATE TABLE telemetryQuarantineReceipts(id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK (state IN ('active','reverted')));
    CREATE TABLE telemetryQuarantineRows(receiptId TEXT NOT NULL,sourceTable TEXT NOT NULL,rowId TEXT NOT NULL,PRIMARY KEY(receiptId,sourceTable,rowId));
    CREATE INDEX idx_quarantine_source_row ON telemetryQuarantineRows(sourceTable,rowId,receiptId);`);
  return db;
}
const visibleUsage = (db) => db.prepare(`SELECT id FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")} ORDER BY id`).all().map((r) => r.id);
const visibleRequests = (db) => db.prepare(`SELECT id FROM requestStats WHERE ${telemetryFilterSql("requestStats", "requestStats")} ORDER BY id`).all().map((r) => r.id);

describe("telemetry quarantine visibility", () => {
  it("excludes only rows held by an active receipt, and restores them when it is reverted", () => {
    const db = fixture();
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r-active','active'),('r-reverted','reverted');
      INSERT INTO telemetryQuarantineRows VALUES('r-active','usageHistory','1'),('r-reverted','usageHistory','2');
      INSERT INTO usageHistory VALUES(1,NULL,NULL),(2,NULL,NULL),(3,NULL,NULL);`);
    expect(visibleUsage(db)).toEqual([2, 3]);

    // A receipt flipped to reverted makes its rows visible again with no cached
    // membership surviving the change, and flipping back hides them again.
    db.exec("UPDATE telemetryQuarantineReceipts SET state='reverted' WHERE id='r-active'");
    expect(visibleUsage(db)).toEqual([1, 2, 3]);
    db.exec("UPDATE telemetryQuarantineReceipts SET state='active' WHERE id='r-active'");
    expect(visibleUsage(db)).toEqual([2, 3]);
    db.close();
  });

  it("keeps rowId identity table-qualified when both tables carry the same id", () => {
    const db = fixture();
    // Numeric usageHistory id 7 and textual requestStats id "7" are different
    // rows; quarantining one must not hide the other.
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','7');
      INSERT INTO usageHistory VALUES(7,NULL,NULL),(8,NULL,NULL);
      INSERT INTO requestStats VALUES('7',NULL,NULL),('8',NULL,NULL);`);
    expect(visibleUsage(db)).toEqual([8]);
    expect(visibleRequests(db)).toEqual(["7", "8"]);
    db.close();
  });

  it("hides test origin, keeps absent and synthetic-import origin visible", () => {
    const db = fixture();
    db.exec("INSERT INTO usageHistory VALUES(1,NULL,NULL),(2,'test',NULL),(3,'import',NULL),(4,'unknown',NULL)");
    expect(visibleUsage(db)).toEqual([1, 3, 4]);
    db.close();
  });

  it("does not let a NULL rowId poison the exclusion set", () => {
    // The shipped schema declares rowId TEXT NOT NULL, so this drops that one
    // constraint to prove the predicate is still safe if a NULL ever reached
    // the table. A NULL inside a NOT IN set makes every comparison unknown and
    // would hide the entire population, which is why the SQL filters it out.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
      CREATE TABLE telemetryQuarantineReceipts(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE telemetryQuarantineRows(receiptId TEXT,sourceTable TEXT,rowId TEXT);
      INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory',NULL),('r','usageHistory','2');
      INSERT INTO usageHistory VALUES(1,NULL,NULL),(2,NULL,NULL),(3,NULL,NULL);`);
    // Row 2 is genuinely quarantined and hidden; the NULL hides nothing.
    expect(visibleUsage(db)).toEqual([1, 3]);
    db.close();
  });

  it("hides a backfilled request whose source usage row is quarantined", () => {
    const db = fixture();
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','10');
      INSERT INTO usageHistory VALUES(10,NULL,NULL),(11,NULL,NULL);
      INSERT INTO requestStats VALUES('rs-from-10',NULL,10),('rs-from-11',NULL,11),('rs-unlinked',NULL,NULL);`);
    expect(visibleRequests(db)).toEqual(["rs-from-11", "rs-unlinked"]);
    // Reverting the receipt restores the backfilled request too.
    db.exec("UPDATE telemetryQuarantineReceipts SET state='reverted' WHERE id='r'");
    expect(visibleRequests(db)).toEqual(["rs-from-10", "rs-from-11", "rs-unlinked"]);
    db.close();
  });

  it("tracks quarantine insert, update and delete, and a reopened connection", () => {
    const path = `${process.env.DATA_DIR ?? "/tmp"}/quarantine-visibility-${process.pid}.sqlite`;
    const create = () => {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE IF NOT EXISTS usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
        CREATE TABLE IF NOT EXISTS telemetryQuarantineReceipts(id TEXT PRIMARY KEY,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS telemetryQuarantineRows(receiptId TEXT NOT NULL,sourceTable TEXT NOT NULL,rowId TEXT NOT NULL,PRIMARY KEY(receiptId,sourceTable,rowId));`);
      return db;
    };
    let db = create();
    try {
      db.exec(`INSERT INTO usageHistory VALUES(1,NULL,NULL),(2,NULL,NULL),(3,NULL,NULL);
        INSERT INTO telemetryQuarantineReceipts VALUES('r','active');`);
      expect(visibleUsage(db)).toEqual([1, 2, 3]);
      db.exec("INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','2')");
      expect(visibleUsage(db)).toEqual([1, 3]);
      db.exec("UPDATE telemetryQuarantineRows SET rowId='3' WHERE rowId='2'");
      expect(visibleUsage(db)).toEqual([1, 2]);
      db.close();

      // A reopened connection sees the same visibility; nothing was cached in
      // the closed process.
      db = create();
      expect(visibleUsage(db)).toEqual([1, 2]);
      db.exec("DELETE FROM telemetryQuarantineRows");
      expect(visibleUsage(db)).toEqual([1, 2, 3]);
    } finally {
      db.close();
      require("node:fs").rmSync(path, { force: true });
    }
  });

  it("builds the membership set once instead of once per population row", () => {
    const db = fixture();
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','1');
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<500) INSERT INTO usageHistory SELECT i,NULL,NULL FROM s;`);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")}`).all().map((r) => r.detail);
    expect(plan.some((step) => /CORRELATED SCALAR SUBQUERY/.test(step))).toBe(false);
    expect(plan.some((step) => /LIST SUBQUERY/.test(step))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usageHistory").get().n).toBe(500);
    db.close();
  });
});
