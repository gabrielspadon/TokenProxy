import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { ContextQueryError, getContextOverview, parseContextFilter } from "@/lib/db/repos/contextRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return adminJson(await getContextOverview(parseContextFilter(new URL(request.url).searchParams)));
  } catch (error) {
    return error instanceof ContextQueryError
      ? adminError(400, "invalid_request", error.message)
      : adminError(500, "state_unavailable", "Context telemetry could not be read.");
  }
}
