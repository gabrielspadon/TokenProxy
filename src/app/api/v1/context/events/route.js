import { resolveClientApiKey } from "@/lib/auth/clientApiKey.js";
import { getAdapter } from "@/lib/db/driver.js";
import { ContextEvidenceError, contextClientKey } from "@/lib/db/repos/contextEvidenceRepo.js";
import { ingestContextEvent } from "@/lib/db/repos/contextClientEventsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const MAX_BYTES = 16384;
const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
export async function OPTIONS() {
  return new Response(null, { headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, x-goog-api-key" } });
}
async function readEvent(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ContextEvidenceError("An event body is required");
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new ContextEvidenceError("Event exceeds 16 KiB", 413); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ContextEvidenceError("Invalid event JSON"); }
  } finally { reader.releaseLock(); }
}
export async function POST(request) {
  try {
    const db = await getAdapter();
    const credential = await resolveClientApiKey(request, (key) => Boolean(contextClientKey(db, key)));
    if (!credential.valid) throw new ContextEvidenceError("A valid client API key is required", 401);
    const result = await ingestContextEvent(credential.apiKey, await readEvent(request));
    return Response.json(result, { status: result.duplicate ? 200 : 201, headers });
  } catch (error) {
    return Response.json({ error: { code: error instanceof ContextEvidenceError ? "invalid_context_event" : "state_unavailable", message: error instanceof ContextEvidenceError ? error.message : "Context event could not be recorded" } }, { status: error instanceof ContextEvidenceError ? error.status : 503, headers });
  }
}
