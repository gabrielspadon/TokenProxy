import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { createUsageProjectionHub } from '@/lib/db/analytics/usageProjection.js';

export const dynamic = "force-dynamic";
const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
// dashboardGuard protects this route. Every authorized dashboard has the same
// global usage permission; credentials and caller-supplied scope are not keys.
const hubKey = Symbol.for('tokenproxy.usageProjectionHub');
function hub() {
  if (globalThis[hubKey]?.emitter !== statsEmitter) {
    globalThis[hubKey]?.hub.close();
    globalThis[hubKey] = { emitter: statsEmitter, hub: createUsageProjectionHub({
      emitter: statsEmitter, readStats: period => getUsageStats(period), readActive: getActiveRequests,
    }) };
  }
  return globalThis[hubKey].hub;
}
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const requestedPeriod = searchParams.get("period") || "today";
  const period = VALID_PERIODS.has(requestedPeriod) ? requestedPeriod : "today";
  // Historical ranges continue to use the paginated stats/chart endpoints.
  try {
    const stream = hub().open({ period, authorizedScope: 'dashboard-usage', signal: request.signal });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no", 'X-TokenProxy-Projection': 'shared-latest-only' } });
  } catch (error) {
    return Response.json({ error: error.name === 'AbortError' ? 'Request cancelled' : 'Usage stream is at capacity. Retry shortly.' },
      { status: error.name === 'AbortError' ? 499 : 503, headers: { 'retry-after': '5', 'cache-control': 'no-store' } });
  }
}
