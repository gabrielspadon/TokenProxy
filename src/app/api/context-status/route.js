import { NextResponse } from "next/server";
import { projectContextStatus } from "@/lib/contextStatusProjection.js";
import { readAllContextStatuses } from "open-sse/handlers/chatCore/contextStatusStore.js";

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 100;
export async function GET() {
  let stored;
  try {
    stored = await readAllContextStatuses({ strict: true });
  } catch (e) {
    // Same honesty contract as /api/token-saver/stats: a read that failed
    // measured nothing, so fail loudly instead of replying 200 with an
    // empty-looking body.
    console.error("[context-status] read failed:", e);
    return NextResponse.json(
      { error: "context status unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const entries = (Array.isArray(stored) ? stored : [])
    .slice(-MAX_ENTRIES)
    .reverse()
    .map(projectContextStatus);

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), entries },
    { headers: { "Cache-Control": "no-store" } }
  );
}
