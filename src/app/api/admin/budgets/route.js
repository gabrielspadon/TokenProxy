import { requireAdmin } from "@/lib/admin/guard.js";
import { getBudgetStatus, releaseBudgetReservation } from "@/lib/db/repos/budgetRepo.js";
import { reconcileBudgetUsage } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 32 * 1024;
const validId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readBody(request) {
  const length = request.headers?.get?.("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new RangeError("Budget request exceeds 32 KiB");
  if (!request.body) throw new SyntaxError("JSON body is required");
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        Promise.resolve(reader.cancel()).catch(() => {});
        throw new RangeError("Budget request exceeds 32 KiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}
export async function GET(request) {
  const refusal = await requireAdmin(request);
  if (refusal) return refusal;
  try {
    const query = new URL(request.url).searchParams;
    const seen = new Set();
    for (const name of query.keys()) {
      if (!["apiKeyId", "limit", "before"].includes(name) || seen.has(name)) return json({ error: "Unknown or duplicate budget query field" }, 400);
      seen.add(name);
    }
    const id = query.get("apiKeyId"), before = query.get("before");
    const rawLimit = query.get("limit") ?? "50", limit = Number(rawLimit);
    if (!validId(id) || (before !== null && !validId(before)) || !/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > 100) return json({ error: "Invalid budget query" }, 400);
    return json(await getBudgetStatus(id, { limit, before }));
  } catch { return json({ error: "Budget state is unavailable" }, 500); }
}
export async function POST(request) {
  const refusal = await requireAdmin(request);
  if (refusal) return refusal;
  try {
    const body = await readBody(request);
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key => !["apiKeyId", "requestId", "evidence"].includes(key))) return json({ error: "Invalid budget request fields" }, 400);
    const { apiKeyId, requestId, evidence } = body;
    if (!validId(apiKeyId) || !validId(requestId) || !evidence || typeof evidence !== "object" || Array.isArray(evidence)
      || Object.keys(evidence).some(key => !["kind", "reference", "tokens"].includes(key))) return json({ error: "Invalid budget request identity or evidence" }, 400);
    const reservation = evidence?.kind === "provider-usage"
      ? await reconcileBudgetUsage(apiKeyId, requestId, evidence)
      : await releaseBudgetReservation(apiKeyId, requestId, evidence);
    return json(reservation ? { reservation } : { error: "Reservation not found" }, reservation ? 200 : 404);
  } catch (error) {
    if (error instanceof RangeError) return json({ error: "Budget request exceeds 32 KiB" }, 413);
    if (error instanceof TypeError || error instanceof SyntaxError) return json({ error: error instanceof SyntaxError ? "Invalid JSON body" : error.message }, 400);
    return json({ error: "Budget state is unavailable" }, 500);
  }
}
