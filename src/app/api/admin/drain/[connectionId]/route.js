import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson, invalidIfMatch, parseAdminBody } from "@/lib/admin/policy.js";
import { readDrainDoc, swapDrainDoc, toDrainState, versionOf } from "@/lib/admin/state.js";
import { decide, idPrefix } from "@/shared/observability/decide.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST and DELETE /api/admin/drain/{connectionId} — start and stop a drain.
 *
 * IDEMPOTENT BY DESIGN. Draining an already-draining connection returns its
 * current state unchanged rather than 409: the caller asked for a state, and
 * the state holds. requestedAt is therefore preserved across a repeated POST,
 * so "how long has this been draining" stays answerable.
 *
 * ifMatch IS OPTIONAL BUT LOAD-BEARING. Omitting it is defensible for a
 * first-time drain of a connection with no prior DrainState, which is the only
 * case where there is nothing to have raced with. Once a document exists, a
 * mismatched ifMatch is a 412 with currentVersion and NOTHING IS WRITTEN — the
 * ABI's byte-identical clause is about this exact path, so every 4xx below
 * returns before the write.
 */

// The document changed between the precondition read and the write, which is
// what an automated remediation acting on the same account looks like. Same
// 412 shape as a stale ifMatch: nothing was written, reload and decide again.
function raced(current) {
  return adminError(412, "version_conflict", "DrainState changed while this request was being processed.", {
    currentVersion: versionOf(current),
  });
}

// Shared by both verbs. Returns the refusal to send, or the document to base
// the new state on.
async function precondition(connectionId, ifMatch) {
  const conn = await getProviderConnectionById(connectionId);
  if (!conn) return { denied: adminError(404, "not_found", `No connection with id ${connectionId}.`) };

  const doc = await readDrainDoc(connectionId);
  if (ifMatch !== undefined && ifMatch !== versionOf(doc)) {
    return {
      denied: adminError(412, "version_conflict", "ifMatch does not match the current DrainState.version.", {
        currentVersion: versionOf(doc),
      }),
    };
  }
  return { doc };
}

export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const parsed = await parseAdminBody(request, ["ifMatch"]);
  if (parsed.error) return adminError(400, "invalid_request", parsed.error);
  const { ifMatch } = parsed.body;
  if (invalidIfMatch(ifMatch)) return adminError(400, "invalid_request", "ifMatch must be a string.");

  const { connectionId } = await params;
  const check = await precondition(connectionId, ifMatch);
  if (check.denied) return check.denied;

  const doc = check.doc;
  if (doc?.isDraining) return adminJson(toDrainState(connectionId, doc));

  const next = { isDraining: true, requestedAt: new Date().toISOString(), completedAt: null };
  const swap = await swapDrainDoc(connectionId, doc, next);
  if (!swap.written) return raced(swap.current);
  // D-11: DRAIN was declared but never emitted. Only an actual state
  // transition speaks — the idempotent early return above stays silent.
  decide("DRAIN", "begin", { conn: idPrefix(connectionId) });
  return adminJson(toDrainState(connectionId, next));
}

export async function DELETE(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  // ifMatch is a query parameter here, not a body field: DELETE bodies are
  // unreliable across proxies and fetch implementations, and the ABI puts it in
  // the query for that reason.
  const raw = request.nextUrl?.searchParams?.get("ifMatch") ?? (() => {
    try {
      return new URL(request.url).searchParams.get("ifMatch");
    } catch {
      return null;
    }
  })();
  const ifMatch = raw === null ? undefined : raw;

  const { connectionId } = await params;
  const check = await precondition(connectionId, ifMatch);
  if (check.denied) return check.denied;

  const doc = check.doc;
  if (!doc?.isDraining) return adminJson(toDrainState(connectionId, doc));

  // The record is kept rather than deleted: completedAt is the evidence that
  // this connection drained and came back, and removing the row would make it
  // indistinguishable from one that never drained.
  const next = {
    isDraining: false,
    requestedAt: doc.requestedAt ?? null,
    completedAt: new Date().toISOString(),
  };
  const swap = await swapDrainDoc(connectionId, doc, next);
  if (!swap.written) return raced(swap.current);
  // D-11: the drain completing is the matching end marker for DRAIN.begin.
  decide("DRAIN", "end", { conn: idPrefix(connectionId) });
  return adminJson(toDrainState(connectionId, next));
}
