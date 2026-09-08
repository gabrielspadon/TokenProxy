import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections, isConnectionDegraded } from "@/lib/db/repos/connectionsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { hasValidCliToken } from "@/dashboardGuard";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/health/detail — readiness, not liveness (#3097).
 *
 * WHY NOT /api/health ITSELF. That route is the liveness probe: the Dockerfile
 * HEALTHCHECK (Dockerfile:67), external liveness checks and
 * the dashboard endpoint ping all read it and all treat a non-200 as dead. If
 * it started failing on a degraded provider an orchestrator would restart a
 * perfectly healthy gateway, so it stays `{ok:true}` and this route carries the
 * diagnosis. This one ALWAYS answers 200 for the same reason — the verdict is
 * in the body.
 *
 * WHY NOT /api/system/state. That endpoint owns rolling traffic metrics
 * (throughput, error rate, p95, spend) and says in its own header comment that
 * per-provider health is deliberately absent from it. This is that half, and it
 * is passive: no upstream is contacted. /api/providers/test-batch remains the
 * ACTIVE test — it spends real quota, so it stays operator-triggered.
 *
 * AUTH. Everything under /api/health/ is public by prefix
 * (src/dashboardGuard.js:31-32,205-209), so the gate is here. An anonymous
 * caller — an uptime probe through a tunnel — gets statuses and uptime only.
 * Provider identities, account names and counts need a session, matching the
 * judgement /api/system/state already makes about the same numbers.
 */

const DEGRADED_STATUS = "degraded";

async function isOperator(request) {
  if (await hasValidCliToken(request)) return true;
  if (await verifyDashboardAuthToken(request.cookies?.get?.("auth_token")?.value)) return true;
  try {
    return (await getSettings()).requireLogin === false;
  } catch {
    return false;
  }
}

// A real query, not a handle check: the adapter fallback chain can hand back an
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

// Passive: reads the state src/sse/services/auth.js already persisted when an
// upstream last rejected or accepted a request. Never contacts a provider.
async function checkUpstreams(now) {
  try {
    const connections = await getProviderConnections({ isActive: true });
    const byProvider = new Map();
    for (const conn of connections) {
      const entry = byProvider.get(conn.provider) ?? {
        provider: conn.provider,
        connections: 0,
        degraded: 0,
        accounts: [],
      };
      entry.connections += 1;
      const bad = isConnectionDegraded(conn, now);
      if (bad) {
        entry.degraded += 1;
        entry.accounts.push({
          connectionId: conn.id,
          account: conn.name || conn.email || null,
          testStatus: conn.testStatus ?? null,
          errorCode: conn.errorCode ?? null,
          rateLimitedUntil: conn.rateLimitedUntil ?? null,
        });
      }
      byProvider.set(conn.provider, entry);
    }
    const providers = [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
    const degraded = providers.reduce((sum, p) => sum + p.degraded, 0);
    return {
      status: degraded > 0 ? DEGRADED_STATUS : "ok",
      enabled: connections.length,
      degraded,
      providers,
      error: null,
    };
  } catch (error) {
    return { status: "error", enabled: null, degraded: null, providers: [], error: error?.message || String(error) };
  }
}

function rollup(checks) {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === DEGRADED_STATUS)) return DEGRADED_STATUS;
  return "ok";
}

export async function GET(request) {
  const now = Date.now();
  const detailed = await isOperator(request);

  const database = await checkDatabase();
  // The upstream scan decrypts every enabled row (~2.8ms each, see
  // connectionsRepo.js:373-378). An anonymous caller never triggers it, which
  // also keeps this route from being an amplifier on a public endpoint.
  const upstreams = detailed
    ? await checkUpstreams(now)
    : { status: "unknown", error: null };

  return NextResponse.json(
    {
      status: rollup([database, upstreams]),
      uptimeSeconds: Math.round(process.uptime()),
      generatedAt: new Date(now).toISOString(),
      detailed,
      checks: detailed
        ? { database, upstreams }
        : {
            database: { status: database.status },
            upstreams: { status: "unknown", reason: "authentication required for upstream detail" },
          },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
