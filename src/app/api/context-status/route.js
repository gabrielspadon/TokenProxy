import { NextResponse } from "next/server";
import { readAllContextStatuses } from "open-sse/handlers/chatCore/contextStatusStore.js";

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 100;
const MAX_STRING = 64;

function nonNegOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function signedOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function strOrNull(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
}

export async function GET() {
  let stored;
  try {
    stored = await readAllContextStatuses();
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
    .map((entry) => ({
      sid: strOrNull(entry?.sid),
      rid: strOrNull(entry?.rid),
      ctxTokens: nonNegOrNull(entry?.ctxTokens),
      saveBytes: signedOrNull(entry?.saveBytes),
      ceBytes: nonNegOrNull(entry?.ceBytes),
      compactHint: boolOrNull(entry?.compactHint),
      updatedAt: strOrNull(entry?.updatedAt),
    }));

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), entries },
    { headers: { "Cache-Control": "no-store" } }
  );
}
