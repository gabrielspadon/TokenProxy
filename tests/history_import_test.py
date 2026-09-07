"""Exercise the offline importer against the actual current declarative schema."""

import hashlib
import importlib.util
import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "history_import", ROOT / "scripts/import-nine-router-history.py"
)
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)
SECRET = "fixture-secret-must-stay-in-source"  # noqa: S105 - deliberate redaction fixture


@contextmanager
def fixture_db(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class HistoryImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(
            subprocess.check_output(  # noqa: S603 - fixed node code against local repository schema
                [
                    shutil.which("node") or "/usr/bin/node",
                    "--input-type=module",
                    "-e",
                    "import {TABLES,buildCreateTableSql} from './src/lib/db/schema.js';"
                    "console.log(JSON.stringify({tables:TABLES,ddl:Object.entries(TABLES).flatMap(([n,d])=>[buildCreateTableSql(n,d),...(d.indexes||[])])}));",
                ],
                cwd=ROOT,
                text=True,
            )
        )

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "source.sqlite"
        self.target = Path(self.tmp.name) / "target.sqlite"
        with fixture_db(self.source) as db:
            for table, cols in importer.HISTORY_COLUMNS.items():
                defs = self.schema["tables"][table]["columns"]
                db.execute(
                    "CREATE TABLE "
                    + importer.identifier(table)
                    + " ("
                    + ",".join(importer.identifier(c) + " " + defs[c] for c in cols)
                    + ")"
                )
            db.execute("CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT)")
            db.execute(
                "CREATE TABLE kv(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key))"
            )
            db.execute("CREATE TABLE usageDaily(dateKey TEXT PRIMARY KEY,data TEXT)")
            db.execute("INSERT INTO settings VALUES(1,?)", (SECRET,))
            db.execute("INSERT INTO kv VALUES('config','key',?)", (SECRET,))
            db.execute("INSERT INTO usageDaily VALUES('2026-07-27',?)", (SECRET,))
            importer.insert(
                db,
                "providerConnections",
                {
                    "id": "same-account",
                    "provider": "provider",
                    "authType": "oauth",
                    "name": "same-name",
                    "email": "same-email",
                    "priority": 1,
                    "isActive": 1,
                    "data": json.dumps({"accessToken": SECRET}),
                    "createdAt": "2026-07-27",
                    "updatedAt": "2026-07-27",
                },
            )
            importer.insert(
                db,
                "usageHistory",
                {
                    "id": 1,
                    "timestamp": "2026-07-27",
                    "provider": "provider",
                    "connectionId": "same-account",
                    "promptTokens": 31,
                    "completionTokens": 7,
                    "cost": 0.17,
                    "apiKey": SECRET,
                    "meta": json.dumps({"costLedgerId": SECRET}),
                    "tokens": json.dumps({"prompt_tokens": 31, "accessToken": SECRET}),
                },
            )
            importer.insert(
                db,
                "requestStats",
                {
                    "id": "same-request",
                    "timestamp": "2026-07-27",
                    "connectionId": "same-account",
                    "status": None,
                    "promptTokens": 31,
                    "completionTokens": 7,
                },
            )
            importer.insert(
                db,
                "requestDetails",
                {
                    "id": "same-request",
                    "timestamp": "2026-07-27",
                    "connectionId": "same-account",
                    "data": json.dumps(
                        {
                            "id": "same-request",
                            "connectionId": "same-account",
                            "request": {"apiKey": SECRET},
                            "taskRef": SECRET,
                            "tokens": {"prompt_tokens": 31, "apiKey": SECRET},
                        }
                    ),
                },
            )
        with fixture_db(self.target) as db:
            for sql in self.schema["ddl"]:
                db.execute(sql)
            importer.insert(
                db,
                "providerConnections",
                {
                    "id": "same-account",
                    "provider": "provider",
                    "authType": "oauth",
                    "name": "same-name",
                    "email": "same-email",
                    "isActive": 1,
                    "data": '{"current":"untouched"}',
                    "createdAt": "2026-09-07",
                    "updatedAt": "2026-09-07",
                },
            )
            importer.insert(
                db,
                "usageHistory",
                {"id": 1, "timestamp": "2026-09-07", "promptTokens": 999},
            )
            importer.insert(
                db,
                "requestStats",
                {"id": "same-request", "timestamp": "2026-09-07", "promptTokens": 999},
            )
            importer.insert(
                db,
                "requestDetails",
                {"id": "same-request", "timestamp": "2026-09-07", "data": "{}"},
            )
            db.execute("INSERT INTO settings VALUES(1,'current-setting')")

    def run_import(self, apply=True, **kwargs):
        plan = importer.run(self.source, self.target, "fixture")
        if not apply:
            return plan
        return importer.run(
            self.source,
            self.target,
            "fixture",
            apply=True,
            expected=plan["sourceFingerprint"],
            snapshot_sha256=plan["sourceSnapshotSha256"],
            **kwargs,
        )

    def test_dry_run_keeps_both_files_byte_identical(self):
        before = [p.read_bytes() for p in (self.source, self.target)]
        plan = self.run_import(False)
        self.assertEqual(before, [p.read_bytes() for p in (self.source, self.target)])
        self.assertEqual(plan["originalIdCollisions"]["usageHistory"], 1)
        self.assertEqual(plan["inserted"]["usageHistory"], 1)

    def test_collisions_are_remapped_without_name_or_email_matching(self):
        self.run_import()
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute(
                    "SELECT promptTokens FROM usageHistory WHERE id=1"
                ).fetchone()[0],
                999,
            )
            account = db.execute(
                "SELECT id,isActive,data FROM providerConnections WHERE id<>'same-account'"
            ).fetchone()
            self.assertEqual(account[1:], (0, "{}"))
            row = db.execute(
                "SELECT connectionId,promptTokens FROM usageHistory WHERE id<>1"
            ).fetchone()
            self.assertEqual(row, (account[0], 31))
            stats = db.execute(
                "SELECT id FROM requestStats WHERE id<>'same-request'"
            ).fetchone()[0]
            detail = db.execute(
                "SELECT id,data FROM requestDetails WHERE id<>'same-request'"
            ).fetchone()
            self.assertEqual(stats, detail[0])
            self.assertEqual(json.loads(detail[1])["id"], stats)

    def test_repeat_is_verified_noop(self):
        first = self.run_import()
        with fixture_db(self.target) as db:
            first_daily = list(db.execute("SELECT * FROM usageDaily"))
        self.assertEqual(self.run_import()["state"], "already-imported-verified")
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM legacyImportRecords").fetchone()[0],
                first["sourceRows"],
            )
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM usageHistory").fetchone()[0], 2
            )
            self.assertEqual(first_daily, list(db.execute("SELECT * FROM usageDaily")))
            self.assertEqual(
                db.execute(
                    "SELECT value FROM _meta WHERE key='totalRequestsLifetime'"
                ).fetchone()[0],
                "1",
            )

    def test_daily_increment_preserves_existing_buckets_and_matches_current_counters(
        self,
    ):
        baseline = {
            "requests": 9,
            "promptTokens": 800,
            "completionTokens": 80,
            "cost": 2.5,
            "byProvider": {
                "other": {
                    "requests": 9,
                    "promptTokens": 800,
                    "completionTokens": 80,
                    "cost": 2.5,
                }
            },
        }
        with fixture_db(self.target) as db:
            db.execute(
                "INSERT INTO usageDaily VALUES(?,?)",
                ("2026-07-27", json.dumps(baseline)),
            )
            db.execute("INSERT INTO _meta VALUES('totalRequestsLifetime','99')")
        self.run_import()
        with fixture_db(self.target) as db:
            actual = json.loads(
                db.execute(
                    "SELECT data FROM usageDaily WHERE dateKey='2026-07-27'"
                ).fetchone()[0]
            )
            self.assertEqual(actual["requests"], 10)
            self.assertEqual(actual["promptTokens"], 831)
            self.assertEqual(actual["completionTokens"], 87)
            self.assertAlmostEqual(actual["cost"], 2.67)
            self.assertEqual(
                actual["byProvider"]["other"], baseline["byProvider"]["other"]
            )
            self.assertEqual(sum(x["requests"] for x in actual["byApiKey"].values()), 1)
            self.assertEqual(
                db.execute(
                    "SELECT value FROM _meta WHERE key='totalRequestsLifetime'"
                ).fetchone()[0],
                "100",
            )

    def test_archive_and_projections_exclude_secret_payloads(self):
        self.run_import()
        self.assertIn(SECRET.encode(), self.source.read_bytes())
        with fixture_db(self.target) as db:
            self.assertNotIn(SECRET, "\n".join(db.iterdump()))
            self.assertEqual(
                db.execute("SELECT data FROM settings").fetchone()[0], "current-setting"
            )
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM usageDaily").fetchone()[0], 1
            )

    def test_missing_lineage_stays_null(self):
        self.run_import()
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute(
                    "SELECT requestId,completionId,logicalRequestId,contextSessionId,projectId,costSource,apiKey FROM usageHistory WHERE id<>1"
                ).fetchone(),
                (None,) * 7,
            )
            self.assertEqual(
                db.execute(
                    "SELECT clientKeyId,taskRef,projectRef,status FROM requestStats WHERE id<>'same-request'"
                ).fetchone(),
                (None,) * 4,
            )

    def test_collision_after_account_insert_rolls_back_everything(self):
        with fixture_db(self.target) as db:
            db.execute(
                "INSERT INTO requestDetails(id,timestamp,data) VALUES(?,?,?)",
                (
                    importer.mapped_id("fixture", "request", "same-request"),
                    "2026-09-07",
                    "{}",
                ),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_import()
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM providerConnections").fetchone()[0], 1
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'legacyImport%'"
                ).fetchone()[0],
                0,
            )

    def test_source_change_or_alias_is_refused(self):
        self.run_import()
        with self.assertRaises(ValueError):
            importer.run(self.source, self.target, "other-source-id")
        with fixture_db(self.source) as db:
            db.execute("UPDATE usageHistory SET promptTokens=32")
        with self.assertRaises(ValueError):
            self.run_import()

    def test_missing_projection_is_not_claimed_as_successful_replay(self):
        self.run_import()
        with fixture_db(self.target) as db:
            db.execute("DELETE FROM usageHistory WHERE id<>1")
        with self.assertRaisesRegex(ValueError, "changed or missing"):
            self.run_import()

    def test_deleted_daily_or_reset_lifetime_is_not_verified_replay(self):
        self.run_import()
        with fixture_db(self.target) as db:
            daily = list(db.execute("SELECT * FROM usageDaily"))
            db.execute("DELETE FROM usageDaily")
        with self.assertRaisesRegex(ValueError, "daily aggregate missing"):
            self.run_import()
        with fixture_db(self.target) as db:
            db.executemany("INSERT INTO usageDaily VALUES(?,?)", daily)
            db.execute("UPDATE _meta SET value='0' WHERE key='totalRequestsLifetime'")
        with self.assertRaisesRegex(ValueError, "lifetime counter below"):
            self.run_import()

    def test_later_aggregate_increments_allow_verified_replay(self):
        self.run_import()
        with fixture_db(self.target) as db:
            day_key, data = db.execute("SELECT * FROM usageDaily").fetchone()
            day = json.loads(data)
            day["requests"] += 1
            day["cost"] += 1
            db.execute(
                "UPDATE usageDaily SET data=? WHERE dateKey=?",
                (json.dumps(day), day_key),
            )
            db.execute("UPDATE _meta SET value='2' WHERE key='totalRequestsLifetime'")
        self.assertEqual(self.run_import()["state"], "already-imported-verified")

    def test_missing_imported_dimension_is_not_verified_replay(self):
        self.run_import()
        with fixture_db(self.target) as db:
            day_key, data = db.execute("SELECT * FROM usageDaily").fetchone()
            day = json.loads(data)
            day["byApiKey"] = {}
            db.execute(
                "UPDATE usageDaily SET data=? WHERE dateKey=?",
                (json.dumps(day), day_key),
            )
        with self.assertRaisesRegex(ValueError, "aggregate counters missing"):
            self.run_import()

    def test_invalid_detail_is_preserved_only_by_snapshot_and_fingerprint(self):
        with fixture_db(self.source) as db:
            db.execute("UPDATE requestDetails SET data='invalid'")
        report = self.run_import()
        self.assertEqual(report["archivedOnly"]["requestDetails"], 1)
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute(
                    "SELECT disposition FROM legacyImportRecords WHERE sourceTable='requestDetails'"
                ).fetchone()[0],
                "archived-unparseable-detail",
            )

    def test_orphan_connection_is_never_rebound(self):
        with fixture_db(self.source) as db:
            db.execute("UPDATE usageHistory SET connectionId='orphan'")
        self.run_import()
        with fixture_db(self.target) as db:
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM usageHistory u JOIN providerConnections c ON u.connectionId=c.id WHERE u.id<>1"
                ).fetchone()[0],
                0,
            )

    def test_apply_requires_exact_snapshot_and_existing_distinct_target(self):
        plan = self.run_import(False)
        with self.assertRaises(ValueError):
            importer.run(
                self.source,
                self.target,
                "fixture",
                apply=True,
                expected=plan["sourceFingerprint"],
                snapshot_sha256="wrong",
            )
        with self.assertRaises(ValueError):
            importer.run(self.source, self.source, "fixture")
        self.assertEqual(
            hashlib.sha256(self.source.read_bytes()).hexdigest(),
            plan["sourceSnapshotSha256"],
        )


if __name__ == "__main__":
    unittest.main()
