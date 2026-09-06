import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { getBridgeStatus } from "@/lib/mcp/stdioSseBridge";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return adminJson(getBridgeStatus());
  } catch {
    return adminError(500, "state_unavailable", "Tool bridge status could not be read.");
  }
}
