import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson, parseAdminBody } from "@/lib/admin/policy.js";
import { ContextQueryError, getContextSession, parseContextFilter, updateContextSession } from "@/lib/db/repos/contextRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const unavailable = (error) => error instanceof ContextQueryError
  ? adminError(400, "invalid_request", error.message)
  : adminError(500, "state_unavailable", "Context telemetry could not be read.");

export async function GET(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const result = await getContextSession(id, parseContextFilter(new URL(request.url).searchParams));
    return result ? adminJson(result) : adminError(404, "not_found", "Session not found.");
  } catch (error) { return unavailable(error); }
}

export async function PATCH(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const parsed = await parseAdminBody(request, ["projectLabel"]);
  if (parsed.error) return adminError(400, "invalid_request", parsed.error);
  try {
    const { id } = await params;
    const updated = await updateContextSession(id, parsed.body);
    return updated ? adminJson({ updated: true }) : adminError(404, "not_found", "Session not found.");
  } catch (error) { return unavailable(error); }
}
