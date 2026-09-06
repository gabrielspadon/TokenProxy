import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { getQuotaHistory, parseQuotaHistoryQuery } from "@/lib/db/repos/quotaHistoryRepo.js";
import { ContextAnalyticsError } from "@/lib/db/analytics/client.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  try { parseQuotaHistoryQuery(params); }
  catch { return adminError(400, "invalid_query", "Invalid quota history filters or pagination."); }
  try { return adminJson(await getQuotaHistory(params, { signal: request.signal })); }
  catch (error) {
    if (error instanceof ContextAnalyticsError) return adminError(503, "state_unavailable", "Quota history is busy or temporarily unavailable. Retry shortly.");
    return adminError(500, "state_unavailable", "Quota history could not be read.");
  }
}
