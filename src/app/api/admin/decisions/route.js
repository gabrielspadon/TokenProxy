import fs from "node:fs";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { sinkFile } from "@/shared/observability/decide.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// One read surface over the decision log, for humans and agents alike: the
// same NDJSON file decide.js appends (docs/logging-design.md §3). Operator
// class (requireAdmin), read-only, and it never parses a value — every record
// was already redacted, truncated and scalar-coerced at write time.
//
// Query: ?cls=CRED&verdict=refresh-failed&rid=ab12cd34&conn=7a1acb09
//        &since=2026-09-06T00:00:00Z&limit=200
// Filters AND together; each matches the record's own field exactly (rid/conn
// are the stored prefixes). Records return newest-last, capped at `limit`
// (default 200, max 2000) from the tail — the symptom an agent starts from is
// recent, and the .1/.2/.3 rotations stay grep-only by design.

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 2000;
// Bounded read: 8 MB from the tail covers days at the measured volume
// (~27 MB/day worst case, §5) without ever pulling a 64 MB file into memory.
const TAIL_BYTES = 8 * 1024 * 1024;

function readTail(file) {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size === 0) return "";
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // A mid-line start point is a torn record; drop up to the first newline.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const q = (k) => url.searchParams.get(k) || undefined;
  const cls = q("cls");
  const verdict = q("verdict");
  const rid = q("rid");
  const conn = q("conn");
  const sinceRaw = q("since");
  const since = sinceRaw ? Date.parse(sinceRaw) : NaN;
  if (sinceRaw && Number.isNaN(since)) {
    return adminError(400, "invalid_request", "since must be an ISO 8601 timestamp.");
  }
  const limitRaw = q("limit");
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "", 10) || LIMIT_DEFAULT, 1), LIMIT_MAX);

  try {
    const records = [];
    for (const line of readTail(sinkFile()).split("\n")) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn or corrupt line is skipped, never a 500
      }
      if (cls && rec.cls !== cls) continue;
      if (verdict && rec.verdict !== verdict) continue;
      if (rid && rec.rid !== rid) continue;
      if (conn && rec.conn !== conn) continue;
      if (sinceRaw && Date.parse(rec.ts) < since) continue;
      records.push(rec);
    }
    return adminJson({ records: records.slice(-limit), total: records.length });
  } catch (error) {
    return adminError(500, "state_unavailable", error?.message || "Decision log could not be read.");
  }
}
