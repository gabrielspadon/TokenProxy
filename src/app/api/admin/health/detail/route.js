import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminJson } from "@/lib/admin/policy.js";
import { readAllDrainDocs } from "@/lib/admin/state.js";
import { toConnection } from "@/lib/admin/project.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/admin/health/detail — readiness with the per-connection verdict.
 *
 * ALWAYS 200. The status is in the body, for the reason /api/health/detail
 * already documents: a caller that treats a non-200 as "process dead" would
 * restart a healthy gateway over one degraded provider.
 *
 * Operator class, unlike its /api/health sibling, because it names every
 * connection. Passive: it reads persisted state and contacts no upstream, so
 * calling it costs no quota. POST .../recheck is the active probe.
 */

// A real query, not a handle check: the adapter fallback chain can return an
// object whose file is unreadable, and only touching it proves otherwise.
async function checkDatabase() {
  const startedAt = Date.now();
  try {
    const db = await getAdapter();
    db.get(`SELECT 1 AS ok`);
    return { status: "ok", driver: db.driver ?? null, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return { status: "error", driver: null, latencyMs: Date.now() - startedAt, error: error?.message || String(error) };
  }
}

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const now = Date.now();
  const database = await checkDatabase();

  let connections = [];
  let scanFailed = false;
  try {
    // Every connection, not just the enabled ones: a connection disabled by an
    // auth failure is precisely what an operator opens this endpoint to find.
    const rows = await getProviderConnections();
    const drains = await readAllDrainDocs();
    connections = rows.map((conn) =>
      toConnection(conn, { isDraining: Boolean(drains[conn.id]?.isDraining), now }),
    );
  } catch {
    scanFailed = true;
  }

  const unhealthy = connections.some((c) => c.status === "degraded" || c.status === "cooldown");
  const status =
    database.status === "error" || scanFailed ? "error" : unhealthy ? "degraded" : "ok";

  return adminJson({ status, scanFailed, checks: { database, connections } });
}
