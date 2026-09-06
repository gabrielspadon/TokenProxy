import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { getApiKeyDeviceCounts } from "@/sse/services/apiKeyDevices.js";
import { requireAdmin } from "@/lib/admin/guard.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/keys/devices
 *
 * How many distinct clients are currently using each API key (#930).
 *
 * The counts live in a rolling in-memory window, which is the report's own
 * non-goal on persistence and the right shape for the question: "who is on this
 * key right now" is not something a growing table answers well.
 *
 * The key itself is never returned. A device count is a property of a key the
 * caller already listed by id, and echoing the secret here would put it in a
 * second response for no reason.
 */
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const counts = getApiKeyDeviceCounts();
    const keys = await getApiKeys();
    return NextResponse.json({
      devices: keys.map((k) => ({
        id: k.id,
        name: k.name || null,
        deviceCount: counts[k.key] || 0,
      })),
      windowMinutes: 30,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error fetching key devices:", error);
    return NextResponse.json({ error: "Failed to fetch key devices" }, { status: 500 });
  }
}
