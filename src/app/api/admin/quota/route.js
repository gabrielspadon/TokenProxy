import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getQuotaHistorySummary } from "@/lib/db/repos/quotaHistoryRepo.js";
import { getAllWindows } from "@/lib/db/repos/quotaWindowsRepo.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { toQuotaSnapshot } from "@/lib/admin/project.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/admin/quota — every connection's quota evidence.
 *
 * One scan, not N per-connection reads: this is a cohort question, and
 * getAllWindows exists because the ranker asks it the same way.
 *
 * A connection with no stored windows is reported with an empty array rather
 * than omitted. Absence of evidence is itself the answer an operator needs —
 * an omitted row reads as a connection that does not exist.
 */
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  try {
    const [conns, byConnection, history] = await Promise.all([getProviderConnections(), getAllWindows(), getQuotaHistorySummary()]);
    const now = Date.now();
    const snapshots = conns.map((conn) => toQuotaSnapshot(conn, byConnection.get(conn.id) ?? [], { now }));
    return adminJson({ snapshots, asOf: new Date(now).toISOString(), mode: "passive", historyAvailable: history.observationCount > 0, historyEndpoint: "/api/admin/quota/history", historyBackfilled: false, retainedHistory: history });
  } catch {
    return adminError(500, "state_unavailable", "Quota state could not be read.");
  }
}
