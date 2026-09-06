import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getWindows } from "@/lib/db/repos/quotaWindowsRepo.js";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson, parseAdminBody } from "@/lib/admin/policy.js";
import { beginRecheck, endRecheck, readDrainDoc, readQualification, writeQualification } from "@/lib/admin/state.js";
import { qualificationDetail } from "@/lib/admin/qualification.js";
import { redactError } from "@/lib/admin/project.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Provider-specific validation may contact an upstream or refresh credentials.
 * Some providers check only local credential presence or expiry. The result
 * does not establish a generated response. A completed check returns 200 with
 * its application verdict, including a failed validation.
 */

// A fresh probe inside this window is reused unless force is set, so a
// dashboard that rechecks on every render does not bill the operator for it.
const FRESH_MS = 60_000;

export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  // Body first, before any state read: a malformed request is a 400 whatever
  // the connection's state turns out to be (admin-abi.md, failure direction).
  const parsed = await parseAdminBody(request, ["force"]);
  if (parsed.error) return adminError(400, "invalid_request", parsed.error);
  const { force } = parsed.body;
  if (force !== undefined && typeof force !== "boolean") {
    return adminError(400, "invalid_request", "force must be a boolean.");
  }

  const { connectionId } = await params;
  const conn = await getProviderConnectionById(connectionId);
  if (!conn) return adminError(404, "not_found", `No connection with id ${connectionId}.`);

  const drain = await readDrainDoc(connectionId);
  if (drain?.isDraining) {
    return adminError(409, "recheck_in_progress", "This connection is draining; a probe would send it new traffic.");
  }

  const previous = await readQualification(connectionId);
  if (!force && previous?.checkedAt && Date.now() - Date.parse(previous.checkedAt) < FRESH_MS) {
    const windows = await getWindows(connectionId);
    return adminJson(qualificationDetail({ conn, drain, probe: previous, windows }));
  }

  // Claimed before the await, released in `finally`: the whole point is that a
  // second request arriving mid-probe is refused rather than queued behind it.
  if (!beginRecheck(connectionId)) {
    return adminError(409, "recheck_in_progress", "A recheck for this connection is already in flight.");
  }

  try {
    const startedAt = Date.now();
    const result = await testSingleConnection(connectionId);
    const probe = {
      ok: typeof result?.valid === "boolean" ? result.valid : null,
      model: null,
      // testSingleConnection reports its own latency for the paths that have
      // one; the wall time is the fallback so the field is never null on a
      // probe that did run.
      latencyMs: Number.isFinite(result?.latencyMs) && result.latencyMs > 0 ? result.latencyMs : Date.now() - startedAt,
      error: redactError(result?.error),
      checkedAt: result?.testedAt ?? new Date().toISOString(),
    };
    await writeQualification(connectionId, probe);

    // Re-read: testSingleConnection persists testStatus and lastError, and the
    // detail's status is derived from them. The in-memory `conn` predates that
    // write, so reporting from it would return the pre-probe verdict.
    const fresh = (await getProviderConnectionById(connectionId)) ?? conn;
    const windows = await getWindows(connectionId);
    return adminJson(qualificationDetail({ conn: fresh, drain, probe, windows }));
  } catch (error) {
    // The probe threw rather than reporting. Still a completed call with a
    // finding, so still a 200 — and the finding is recorded, or a thrown probe
    // would leave the connection looking never-checked.
    const probe = {
      ok: false,
      model: null,
      latencyMs: null,
      error: redactError(error?.message || String(error)),
      checkedAt: new Date().toISOString(),
    };
    await writeQualification(connectionId, probe);
    const windows = await getWindows(connectionId).catch(() => []);
    return adminJson(qualificationDetail({ conn, drain, probe, windows }));
  } finally {
    endRecheck(connectionId);
  }
}
