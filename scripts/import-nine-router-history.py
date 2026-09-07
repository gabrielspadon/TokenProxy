#!/usr/bin/env python3
# ruff: noqa: S608
# SQL values are bound; every dynamic identifier is double-quoted by identifier().
"""Import one frozen Nine Router SQLite snapshot without activating its state."""

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

CONTRACT = "nine-router-history-v1"
HISTORY_COLUMNS = {
    "usageHistory": [
        "id",
        "timestamp",
        "provider",
        "model",
        "connectionId",
        "apiKey",
        "endpoint",
        "promptTokens",
        "completionTokens",
        "cost",
        "status",
        "tokens",
        "meta",
    ],
    "requestStats": [
        "id",
        "timestamp",
        "provider",
        "model",
        "connectionId",
        "status",
        "promptTokens",
        "completionTokens",
        "cachedTokens",
        "cacheCreationTokens",
        "reasoningTokens",
        "latencyTotal",
        "latencyTtft",
    ],
    "requestDetails": [
        "id",
        "timestamp",
        "provider",
        "model",
        "connectionId",
        "status",
        "data",
    ],
    "providerConnections": [
        "id",
        "provider",
        "authType",
        "name",
        "email",
        "priority",
        "isActive",
        "data",
        "createdAt",
        "updatedAt",
    ],
}
SOURCE_DDL = """CREATE TABLE IF NOT EXISTS legacyImportSources (
    sourceId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
    contract TEXT NOT NULL, schemaJson TEXT NOT NULL, importedAt TEXT NOT NULL,
    sourceRows INTEGER NOT NULL, snapshotPath TEXT NOT NULL, snapshotSha256 TEXT NOT NULL,
    aggregatesJson TEXT NOT NULL)"""
RECORD_DDL = """CREATE TABLE IF NOT EXISTS legacyImportRecords (
    sourceId TEXT NOT NULL REFERENCES legacyImportSources(sourceId),
    sourceTable TEXT NOT NULL, sourceKey TEXT NOT NULL, rawRow TEXT NOT NULL, rowFingerprint TEXT NOT NULL,
    disposition TEXT NOT NULL, targetTable TEXT, targetId TEXT, projection TEXT,
    PRIMARY KEY (sourceId, sourceTable, sourceKey))"""


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def packed(value):
    """Losslessly encode SQLite scalar types, including blobs and float edges."""
    if isinstance(value, dict):
        return {k: packed(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [packed(v) for v in value]
    if isinstance(value, bytes):
        return {"sqliteBlob": base64.b64encode(value).decode("ascii")}
    if isinstance(value, float):
        return {"sqliteFloat": value.hex()}
    return value


def encoded(value):
    return json.dumps(
        packed(value), sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def connect(path, writable=False):
    db = sqlite3.connect(
        Path(path).resolve().as_uri() + ("?mode=rw" if writable else "?mode=ro"),
        uri=True,
        isolation_level=None,
        timeout=30,
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    if not writable:
        db.execute("PRAGMA query_only=ON")
    return db


def inventory(source, max_rows=10000, max_bytes=64 * 1024 * 1024):
    source.execute("BEGIN")
    try:
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Source integrity check failed")
        schema = [
            dict(r)
            for r in source.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"
            )
        ]
        tables = [r["name"] for r in schema if r["type"] == "table"]
        records, columns = {}, {}
        total = size = 0
        for table in tables:
            info = list(source.execute("PRAGMA table_info(" + identifier(table) + ")"))
            columns[table] = [r["name"] for r in info]
            primary = [
                r["name"] for r in sorted(info, key=lambda r: r["pk"]) if r["pk"]
            ]
            count = source.execute(
                "SELECT COUNT(*) FROM " + identifier(table)
            ).fetchone()[0]
            total += count
            if total > max_rows:
                raise ValueError("Source exceeds bounded row limit")
            # rowid preserves multiplicity for legacy tables with no declared key.
            order = ",".join(map(identifier, primary)) if primary else "rowid"
            prefix = "" if primary else "rowid AS __source_rowid__,"
            records[table] = []
            for result in source.execute(
                "SELECT "
                + prefix
                + "* FROM "
                + identifier(table)
                + " ORDER BY "
                + order
            ):
                row = dict(result)
                key = digest(
                    [row[c] for c in primary]
                    if primary
                    else [row.pop("__source_rowid__")]
                )
                size += len(encoded(row).encode())
                if size > max_bytes:
                    raise ValueError("Source exceeds bounded payload limit")
                records[table].append((key, row))
        for table, expected in HISTORY_COLUMNS.items():
            if columns.get(table) != expected:
                raise ValueError("Unsupported legacy projection schema for " + table)
        fingerprint = digest({"schema": schema, "records": records})
        return {
            "schema": schema,
            "records": records,
            "fingerprint": fingerprint,
            "count": total,
        }
    finally:
        source.execute("ROLLBACK")


def mapped_id(source_id, kind, original):
    return "legacy-" + kind + "-" + digest([source_id, kind, original])


def archive_row(table, row):
    # Opaque payloads and all configuration values remain exclusively in the snapshot.
    safe = set(HISTORY_COLUMNS.get(table, [])) - {"data", "apiKey", "meta", "tokens"}
    return {
        key: value if key in safe else {"preservedInPrivateSnapshot": True}
        for key, value in row.items()
    }


def numeric_object(value):
    if not isinstance(value, dict):
        return {}
    allowed = {
        "prompt_tokens",
        "completion_tokens",
        "cached_tokens",
        "cache_creation_tokens",
        "cache_creation_input_tokens",
        "reasoning_tokens",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "total",
        "ttft",
    }
    return {
        key: val
        for key, val in value.items()
        if key in allowed
        and isinstance(val, (int, float))
        and not isinstance(val, bool)
    }


def project(source_id, table, row):
    if table not in HISTORY_COLUMNS:
        return None, "archived-original-state"
    result = dict(row)
    if table == "providerConnections":
        result.update(
            id=mapped_id(source_id, "account", row["id"]), isActive=0, data="{}"
        )
        return result, "inactive-metadata-only-credentials-archived"
    if row.get("connectionId") is not None:
        result["connectionId"] = mapped_id(source_id, "account", row["connectionId"])
    if table == "usageHistory":
        result.pop("id")
        result["apiKey"] = (
            None  # Never bind retired credentials to live budget enforcement.
        )
        result["meta"] = json.dumps(
            {
                "legacyImport": {
                    "contract": CONTRACT,
                    "sourceId": source_id,
                    "apiKeyIdentity": "unavailable",
                }
            },
            separators=(",", ":"),
        )
        try:
            token_data = numeric_object(json.loads(row["tokens"]))
        except (ValueError, TypeError):
            token_data = {}
        result["tokens"] = json.dumps(token_data) if token_data else None
    else:
        result["id"] = mapped_id(source_id, "request", row["id"])
    if table == "requestDetails":
        try:
            data = json.loads(row["data"])
        except (TypeError, ValueError):
            return None, "archived-unparseable-detail"
        if not isinstance(data, dict):
            return None, "archived-nonobject-detail"
        data["id"] = result["id"]
        data["connectionId"] = result.get("connectionId")
        # Only the legacy top-level detail contract reaches the current reader.
        keys = [
            "id",
            "timestamp",
            "provider",
            "model",
            "connectionId",
            "status",
            "latency",
            "tokens",
        ]
        for key in ("latency", "tokens"):
            if key in data:
                data[key] = numeric_object(data[key])
        result["data"] = json.dumps(
            {k: data[k] for k in keys if k in data}, separators=(",", ":")
        )
    return result, "history-projection-original-archived"


def insert(db, table, values):
    names = list(values)
    sql = (
        "INSERT INTO "
        + identifier(table)
        + " ("
        + ",".join(map(identifier, names))
        + ") VALUES ("
        + ",".join("?" for _ in names)
        + ")"
    )
    return db.execute(sql, [values[k] for k in names])


def increment_daily(db, usage):
    """Increment only this import's usage using usageRepo's local-day counters."""
    timestamp = datetime.fromisoformat(usage["timestamp"].replace("Z", "+00:00"))
    day_key = timestamp.astimezone().date().isoformat()
    previous = db.execute(
        "SELECT data FROM usageDaily WHERE dateKey=?", (day_key,)
    ).fetchone()
    day = json.loads(previous[0]) if previous else {}
    if not isinstance(day, dict):
        raise ValueError("Existing daily aggregate is not an object")
    tokens = json.loads(usage["tokens"]) if usage.get("tokens") else {}
    values = {
        "requests": 1,
        "promptTokens": usage.get("promptTokens") or 0,
        "completionTokens": usage.get("completionTokens") or 0,
        "cachedTokens": tokens.get("cached_tokens") or 0,
        "cacheCreationTokens": tokens.get("cache_creation_input_tokens") or 0,
        "cost": usage.get("cost") or 0,
    }

    def add(target):
        for key, value in values.items():
            target[key] = (target.get(key) or 0) + value

    def bucket(dimension, key, meta=None):
        target = day.setdefault(dimension, {}).setdefault(key, {})
        add(target)
        if meta:
            target.update(meta)

    add(day)
    for dimension in (
        "byProvider",
        "byModel",
        "byAccount",
        "byApiKey",
        "byEndpoint",
        "byReasoning",
    ):
        day.setdefault(dimension, {})
    provider, model = usage.get("provider"), usage.get("model")
    model_name = str(model) if model is not None else "null"
    meta = {"rawModel": model, "provider": provider}
    if provider:
        bucket("byProvider", provider)
    bucket("byModel", model_name + ("|" + provider if provider else ""), meta)
    if usage.get("connectionId"):
        bucket("byAccount", usage["connectionId"], meta)
    bucket(
        "byApiKey",
        "legacy-unavailable|" + model_name + "|" + (provider or "unknown"),
        {**meta, "apiKey": None, "legacyKeyUnavailable": True},
    )
    endpoint = usage.get("endpoint") or "Unknown"
    bucket(
        "byEndpoint",
        endpoint + "|" + model_name + "|" + (provider or "unknown"),
        {**meta, "endpoint": endpoint},
    )
    db.execute(
        "INSERT INTO usageDaily(dateKey,data) VALUES(?,?) ON CONFLICT(dateKey) DO UPDATE SET data=excluded.data",
        (day_key, json.dumps(day, separators=(",", ":"), allow_nan=False)),
    )
    return day_key


def numeric_counters(value):
    if not isinstance(value, dict):
        return {}
    counters = {
        "requests",
        "promptTokens",
        "completionTokens",
        "cachedTokens",
        "cacheCreationTokens",
        "cost",
    }
    return {
        key: val if key in counters else numeric_counters(val)
        for key, val in value.items()
        if (
            key in counters
            and isinstance(val, (int, float))
            and not isinstance(val, bool)
        )
        or isinstance(val, dict)
    }


def verify_counter_bounds(actual, minimum):
    for key, value in minimum.items():
        current = actual.get(key) if isinstance(actual, dict) else None
        if isinstance(value, dict):
            verify_counter_bounds(current, value)
        elif (
            not isinstance(current, (int, float))
            or isinstance(current, bool)
            or current < value
        ):
            raise ValueError(
                "Imported aggregate counters missing or below receipt; reconciliation required"
            )


def verify_replay(db, snapshot, source_id):
    records = list(
        db.execute("SELECT * FROM legacyImportRecords WHERE sourceId=?", (source_id,))
    )
    expected = {
        (t, k): (encoded(archive_row(t, r)), digest(r))
        for t, rows in snapshot["records"].items()
        for k, r in rows
    }
    if len(records) != len(expected):
        raise ValueError("Import archive row count mismatch")
    for record in records:
        if expected.get((record["sourceTable"], record["sourceKey"])) != (
            record["rawRow"],
            record["rowFingerprint"],
        ):
            raise ValueError("Import archive content mismatch")
        if record["targetTable"]:
            row = db.execute(
                "SELECT * FROM " + identifier(record["targetTable"]) + " WHERE id=?",
                (record["targetId"],),
            ).fetchone()
            projected = json.loads(record["projection"])
            if (
                row is None
                or encoded({k: row[k] for k in projected}) != record["projection"]
            ):
                raise ValueError(
                    "Imported projection changed or missing; original remains archived"
                )
    source = db.execute(
        "SELECT aggregatesJson FROM legacyImportSources WHERE sourceId=?", (source_id,)
    ).fetchone()
    receipt = json.loads(source[0])
    for day_key, counters in receipt.get("days", {}).items():
        row = db.execute(
            "SELECT data FROM usageDaily WHERE dateKey=?", (day_key,)
        ).fetchone()
        if not row:
            raise ValueError("Imported daily aggregate missing")
        verify_counter_bounds(json.loads(row[0]), counters)
    lifetime = db.execute(
        "SELECT value FROM _meta WHERE key='totalRequestsLifetime'"
    ).fetchone()
    if not lifetime or int(lifetime[0]) < receipt["lifetimeMinimum"]:
        raise ValueError("Imported lifetime counter below receipt")


def apply_snapshot(db, snapshot, source_id):
    """Archive, project, verify, and receipt atomically under one writer lock."""
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute(SOURCE_DDL)
        db.execute(RECORD_DDL)
        previous = db.execute(
            "SELECT * FROM legacyImportSources WHERE sourceId=? OR fingerprint=?",
            (source_id, snapshot["fingerprint"]),
        ).fetchone()
        if previous:
            if (
                previous["sourceId"] != source_id
                or previous["fingerprint"] != snapshot["fingerprint"]
                or previous["contract"] != CONTRACT
            ):
                raise ValueError(
                    "Source identity, fingerprint, or import contract changed"
                )
            verify_replay(db, snapshot, source_id)
            db.execute("ROLLBACK")
            return {
                "state": "already-imported-verified",
                "sourceRows": snapshot["count"],
                "inserted": {},
            }
        tables = tuple(HISTORY_COLUMNS)
        triggers = db.execute(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (?,?,?,?)",
            tables,
        ).fetchone()[0]
        if triggers:
            raise ValueError("Destination projection tables have unreviewed triggers")
        before = {
            table: db.execute("SELECT COUNT(*) FROM " + identifier(table)).fetchone()[0]
            for table in tables
        }
        insert(
            db,
            "legacyImportSources",
            {
                "sourceId": source_id,
                "fingerprint": snapshot["fingerprint"],
                "contract": CONTRACT,
                "schemaJson": encoded(snapshot["schema"]),
                "sourceRows": snapshot["count"],
                "snapshotPath": snapshot["path"],
                "snapshotSha256": snapshot["fileSha256"],
                "aggregatesJson": "{}",
                "importedAt": datetime.now(UTC).isoformat(),
            },
        )
        inserted, collisions, archived = {}, {}, {}
        touched_days = set()
        # Accounts precede any history which refers to their exact legacy identity.
        ordered = [
            "providerConnections",
            *sorted(set(snapshot["records"]) - {"providerConnections"}),
        ]
        for table in ordered:
            inserted[table] = collisions[table] = archived[table] = 0
            for key, raw in snapshot["records"][table]:
                projection, disposition = project(source_id, table, raw)
                if table in tables:
                    collisions[table] += bool(
                        db.execute(
                            "SELECT 1 FROM " + identifier(table) + " WHERE id=?",
                            (raw["id"],),
                        ).fetchone()
                    )
                target_id = None
                if projection is not None:
                    cursor = insert(db, table, projection)
                    target_id = projection.get("id", cursor.lastrowid)
                    projection["id"] = target_id
                    inserted[table] += 1
                    if table == "usageHistory":
                        touched_days.add(increment_daily(db, projection))
                else:
                    archived[table] += 1
                insert(
                    db,
                    "legacyImportRecords",
                    {
                        "sourceId": source_id,
                        "sourceTable": table,
                        "sourceKey": key,
                        "rawRow": encoded(archive_row(table, raw)),
                        "rowFingerprint": digest(raw),
                        "disposition": disposition,
                        "targetTable": table if projection is not None else None,
                        "targetId": str(target_id) if target_id is not None else None,
                        "projection": encoded(projection)
                        if projection is not None
                        else None,
                    },
                )
        lifetime = db.execute(
            "SELECT value FROM _meta WHERE key='totalRequestsLifetime'"
        ).fetchone()
        lifetime_before = int(lifetime[0]) if lifetime else 0
        lifetime_after = lifetime_before + inserted["usageHistory"]
        db.execute(
            "INSERT INTO _meta(key,value) VALUES('totalRequestsLifetime',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(lifetime_after),),
        )
        aggregate_receipt = {"lifetimeMinimum": lifetime_after, "days": {}}
        for day_key in sorted(touched_days):
            daily = db.execute(
                "SELECT data FROM usageDaily WHERE dateKey=?", (day_key,)
            ).fetchone()
            aggregate_receipt["days"][day_key] = numeric_counters(json.loads(daily[0]))
        db.execute(
            "UPDATE legacyImportSources SET aggregatesJson=? WHERE sourceId=?",
            (
                json.dumps(aggregate_receipt, separators=(",", ":"), allow_nan=False),
                source_id,
            ),
        )
        after = {
            table: db.execute("SELECT COUNT(*) FROM " + identifier(table)).fetchone()[0]
            for table in tables
        }
        if any(after[t] - before[t] != inserted[t] for t in tables):
            raise ValueError("Destination row deltas do not match import")
        verify_replay(db, snapshot, source_id)
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Destination foreign key check failed")
        db.execute("COMMIT")
        return {
            "state": "imported-verified",
            "sourceRows": snapshot["count"],
            "inserted": inserted,
            "originalIdCollisions": collisions,
            "archivedOnly": archived,
            "before": before,
            "after": after,
            "lifetimeBefore": lifetime_before,
            "lifetimeAfter": lifetime_after,
        }
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def run(
    source_path,
    target_path,
    source_id,
    *,
    apply=False,
    expected=None,
    snapshot_sha256=None,
):
    if os.path.samefile(source_path, target_path):
        raise ValueError("Source and destination must be distinct files")
    if apply and (not snapshot_sha256 or not expected):
        raise ValueError(
            "Apply requires both logical source and snapshot byte fingerprints"
        )
    wal = Path(str(source_path) + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise ValueError("Source must be a frozen SQLite backup with no pending WAL")
    file_hash = hashlib.sha256(Path(source_path).read_bytes()).hexdigest()
    if snapshot_sha256 and snapshot_sha256 != file_hash:
        raise ValueError("Snapshot byte fingerprint differs")
    with closing(connect(source_path)) as source:
        snapshot = inventory(source)
    if hashlib.sha256(Path(source_path).read_bytes()).hexdigest() != file_hash:
        raise ValueError("Source snapshot changed during read")
    snapshot.update(path=str(Path(source_path).resolve()), fileSha256=file_hash)
    if expected and snapshot["fingerprint"] != expected:
        raise ValueError("Source fingerprint differs from approved snapshot")
    target = connect(target_path, writable=apply)
    working = target
    try:
        if not apply:
            working = sqlite3.connect(":memory:", isolation_level=None)
            working.row_factory = sqlite3.Row
            target.backup(working)
            working.execute("PRAGMA foreign_keys=ON")
        report = apply_snapshot(working, snapshot, source_id)
        report.update(
            mode="apply" if apply else "dry-run-memory-clone",
            sourceFingerprint=snapshot["fingerprint"],
            sourceSnapshotSha256=file_hash,
            contract=CONTRACT,
        )
        return report
    finally:
        if working is not target:
            working.close()
        target.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--expect-source-sha256")
    parser.add_argument("--source-snapshot-sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        result = run(
            args.source,
            args.target,
            args.source_id,
            apply=args.apply,
            expected=args.expect_source_sha256,
            snapshot_sha256=args.source_snapshot_sha256,
        )
    except (ValueError, OSError, sqlite3.Error):
        # Errors from arbitrary source schemas/constraints can contain secret values.
        print(
            json.dumps(
                {
                    "state": "failed",
                    "message": "Import refused or rolled back; no payload logged",
                }
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
