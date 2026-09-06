import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { getContextEvents } from "@/lib/db/repos/contextClientEventsRepo.js";
import { parseContextEventFilter } from "@/lib/db/analytics/contextEvents.mjs";
import { ContextQueryError } from "@/lib/db/analytics/contextQueries.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try { return adminJson(await getContextEvents(parseContextEventFilter(new URL(request.url).searchParams), { signal: request.signal })); }
  catch (error) { return error instanceof ContextQueryError ? adminError(400,"invalid_request",error.message) : adminError(503,"state_unavailable","Context events could not be read"); }
}
