import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getWindows } from "@/lib/db/repos/quotaWindowsRepo.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { toQuotaSnapshot } from "@/lib/admin/project.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/admin/quota/{connectionId} — one connection's quota evidence.
 *
 * The 404 is on the CONNECTION, never on the windows: a real connection that
 * has never had a quota read is a 200 with an empty array, because "no evidence
 * yet" and "no such account" are different answers and rule 2 turns on the
 * difference.
 */
export async function GET(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const { connectionId } = await params;
  try {
    const conn = await getProviderConnectionById(connectionId);
    if (!conn) return adminError(404, "not_found", `No connection with id ${connectionId}.`);
    return adminJson(toQuotaSnapshot(conn, await getWindows(connectionId)));
  } catch {
    return adminError(500, "state_unavailable", "Quota state could not be read.");
  }
}
