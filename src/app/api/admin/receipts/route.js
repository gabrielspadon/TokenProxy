import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { ReceiptQueryError, queryReceipts } from "@/lib/admin/receipts.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/admin/receipts — why sessions moved between accounts.
 *
 * Rule 8's audit trail, newest first, filtered by connection, model or time and
 * paged by an opaque cursor. Receipts carry no credential, no prompt and no raw
 * session id by construction (src/lib/admin/project.js picks every field by
 * name), so this endpoint cannot disclose one by adding a filter.
 */
function searchParams(request) {
  if (request.nextUrl?.searchParams) return request.nextUrl.searchParams;
  try {
    return new URL(request.url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  try {
    const q = searchParams(request);
    return adminJson(
      await queryReceipts({
        provider: q.get("provider"),
        connectionId: q.get("connectionId"),
        model: q.get("model"),
        since: q.get("since"),
        until: q.get("until"),
        limit: q.get("limit"),
        cursor: q.get("cursor"),
      }),
    );
  } catch (error) {
    // A typed parameter the caller got wrong is 400, never 500: `limit`, `since`
    // and `cursor` are documented types in the admin ABI, and answering the
    // default page for a malformed one left a caller unable to tell a rejected
    // parameter from a filter that happened to match it.
    if (error instanceof ReceiptQueryError) {
      return adminError(400, "invalid_request", error.message);
    }
    return adminError(500, "state_unavailable", error?.message || "Receipts could not be read.");
  }
}
