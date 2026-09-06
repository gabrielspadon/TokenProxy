import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

// The explicit POST is deliberate disclosure of this one credential. List,
// detail, device and update responses never include the stored value.
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (typeof id !== "string" || id.length > 128) return adminError(400, "invalid_key_id", "Invalid key identifier.");
    const stored = await getApiKeyById(id);
    if (!stored) return adminError(404, "key_not_found", "Key not found.");
    return adminJson({ id: stored.id, name: stored.name, key: stored.key, isActive: stored.isActive,
      isExpired: stored.isExpired, expiresAt: stored.expiresAt, disclosure: "explicit-operator-request" });
  } catch {
    return adminError(500, "key_unavailable", "The key could not be revealed.");
  }
}
