import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import initSqlJs from "sql.js";
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
    // Unique per process and per run so a future parallel runner cannot collide.
    const path = `${process.env.DATA_DIR ?? "/tmp"}/quarantine-visibility-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
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
      rmSync(path, { force: true });
    }
  });

  it("keeps leading-zero text ids distinct from their numeric lookalike", () => {
    const db = fixture();
    // rowId is TEXT. Quarantining the exact string "07" must not hide row 7,
    // and CAST(7 AS TEXT) is "7", never "07". A numeric comparison anywhere in
    // this predicate would collapse the two and hide the wrong row.
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','07');
      INSERT INTO usageHistory VALUES(7,NULL,NULL);
      INSERT INTO requestStats VALUES('07',NULL,NULL),('7',NULL,NULL);`);
    expect(visibleUsage(db)).toEqual([7]);

    // Same string on the requestStats side hides "07" and leaves "7" visible.
    db.exec("INSERT INTO telemetryQuarantineRows VALUES('r','requestStats','07')");
    expect(visibleRequests(db)).toEqual(['7']);
    db.close();
  });

  it("keeps a requestStats row with a NULL id visible", () => {
    const db = new DatabaseSync(":memory:");
    // requestStats.id is nullable in this arm, and CAST(NULL AS TEXT) is NULL,
    // so a NOT IN comparison would be unknown and drop the row. The id IS NULL
    // arm is what reproduces the old NOT EXISTS answer of visible.
    db.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
      CREATE TABLE requestStats(id TEXT,dataOrigin TEXT,sourceUsageId INTEGER);
      CREATE TABLE telemetryQuarantineReceipts(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE telemetryQuarantineRows(receiptId TEXT NOT NULL,sourceTable TEXT NOT NULL,rowId TEXT NOT NULL,PRIMARY KEY(receiptId,sourceTable,rowId));
      INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','requestStats','rs-1');
      INSERT INTO requestStats VALUES(NULL,NULL,NULL),('rs-1',NULL,NULL),('rs-2',NULL,NULL);`);
    const rows = db.prepare(`SELECT id FROM requestStats WHERE ${telemetryFilterSql("requestStats", "requestStats")}`).all().map((r) => r.id);
    expect(rows).toEqual([null, "rs-2"]);
    db.close();
  });

  it("executes the optimized predicate on SQL.js, not only node:sqlite", async () => {
    // Version support is not execution proof. SQL.js is the pure-WASM fallback
    // in the driver chain, so the same predicate text runs here for real.
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
      CREATE TABLE requestStats(id TEXT PRIMARY KEY,dataOrigin TEXT,sourceUsageId INTEGER);
      CREATE TABLE telemetryQuarantineReceipts(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE telemetryQuarantineRows(receiptId TEXT NOT NULL,sourceTable TEXT NOT NULL,rowId TEXT NOT NULL,PRIMARY KEY(receiptId,sourceTable,rowId));
      INSERT INTO telemetryQuarantineReceipts VALUES('r-a','active'),('r-b','reverted');
      INSERT INTO telemetryQuarantineRows VALUES('r-a','usageHistory','1'),('r-b','usageHistory','2'),('r-a','usageHistory','07');
      INSERT INTO usageHistory VALUES(1,NULL,NULL),(2,NULL,NULL),(3,'test',NULL),(4,'import',NULL),(7,NULL,NULL);
      INSERT INTO requestStats VALUES('rs-from-1',NULL,1),('rs-from-2',NULL,2);`);
    const ids = (sql) => { const r = db.exec(sql); return r.length ? r[0].values.map((v) => v[0]) : []; };

    // Active receipt hides 1, reverted leaves 2, test origin hidden, import
    // visible, and "07" does not hide numeric 7.
    expect(ids(`SELECT id FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")} ORDER BY id`)).toEqual([2, 4, 7]);
    // Backfill arm: the request sourced from quarantined usage row 1 is hidden.
    expect(ids(`SELECT id FROM requestStats WHERE ${telemetryFilterSql("requestStats", "requestStats")} ORDER BY id`)).toEqual(["rs-from-2"]);
    // The plan carries no per-row correlated subquery on this engine either.
    const plan = db.exec(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")}`);
    const steps = plan[0].values.map((row) => String(row[row.length - 1]));
    expect(steps.some((step) => /CORRELATED SCALAR SUBQUERY/.test(step))).toBe(false);
    db.close();
  });

  it("builds the membership set once instead of once per population row", () => {
    const db = fixture();
    db.exec(`INSERT INTO telemetryQuarantineReceipts VALUES('r','active');
      INSERT INTO telemetryQuarantineRows VALUES('r','usageHistory','1');
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<500) INSERT INTO usageHistory SELECT i,NULL,NULL FROM s;`);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")}`).all().map((r) => r.detail);
    expect(plan.some((step) => /CORRELATED SCALAR SUBQUERY/.test(step))).toBe(false);
    expect(plan.some((step) => /LIST SUBQUERY/.test(step))).toBe(true);
    // Connect the plan to semantics: all 500 rows exist, exactly one is
    // quarantined, so the predicate must return 499. A set-build that silently
    // matched nothing would still produce the LIST SUBQUERY plan above.
    expect(db.prepare("SELECT COUNT(*) AS n FROM usageHistory").get().n).toBe(500);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM usageHistory WHERE ${telemetryFilterSql("usageHistory", "usageHistory")}`).get().n).toBe(499);
    expect(visibleUsage(db)).not.toContain(1);
    db.close();
  });
});
