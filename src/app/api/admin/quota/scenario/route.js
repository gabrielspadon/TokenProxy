import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { captureRoutingState } from '@/lib/admin/routingCapture.js';
import { getQuotaWorkbench } from '@/lib/db/repos/quotaWorkbenchRepo.js';
import { parseQuotaWorkbenchQuery } from '@/lib/db/analytics/quotaWorkbenchQueries.mjs';
import { createFleetCapture, compareFleetScenario, FLEET_LIMITS } from '@/lib/quotaFleetScenario.js';
import { SimulationError } from '@/lib/routingSimulation.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

async function readBody(request) {
  if (new URL(request.url).search) throw new SimulationError('invalid_query');
  const reader = request.body?.getReader(), chunks = [];
  let bytes = 0;
  if (!reader) throw new SimulationError('invalid_json');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FLEET_LIMITS.bodyBytes) { void reader.cancel().catch(() => {}); throw new SimulationError('fleet_body_limit', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SimulationError('invalid_json'); }
}
export async function POST(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['capture', 'compare'].includes(body.operation)) throw new SimulationError('invalid_operation');
    const keys = body.operation === 'capture' ? ['operation', 'input', 'sessionHash', 'start', 'end'] : ['operation', 'capture', 'input', 'scenario'];
    if (Object.keys(body).some(key => !keys.includes(key))) throw new SimulationError('invalid_fields');
    if (body.operation === 'compare') return adminJson(compareFleetScenario(body));
    const { capture: routing, input } = await captureRoutingState(body);
    if (routing.accounts.length > FLEET_LIMITS.accounts) throw new SimulationError('fleet_account_limit', 413);
    const params = new URLSearchParams({ connectionId: routing.accounts[0]?.id ?? 'empty', ...(body.start ? { start: body.start } : {}), end: body.end ?? routing.capturedAt });
    const parsed = parseQuotaWorkbenchQuery(params);
    if (parsed.end > routing.capturedAt) throw new SimulationError('future_history_range');
    const histories = [];
    // Bounded sequential reads avoid flooding the shared analytics worker.
    for (const account of routing.accounts) {
      params.set('connectionId', account.id);
      const history = await getQuotaWorkbench(params, { signal: request.signal });
      histories.push({ connectionId: account.id, complete: history.complete, total: history.total,
        series: history.series.map(series => Object.fromEntries(['id', 'scope', 'source', 'observationKind', 'resourceType', 'unit', 'windowType', 'windowDurationMs', 'measurement', 'points'].map(key => [key, series[key]]))) });
    }
    const capture = createFleetCapture({ routing, histories, period: { start: parsed.start, end: parsed.end } });
    if (Buffer.byteLength(JSON.stringify(capture)) > FLEET_LIMITS.bodyBytes / 2) throw new SimulationError('fleet_capture_limit', 413);
    return adminJson({ capture, input, comparison: compareFleetScenario({ capture, input }) });
  } catch (error) {
    if (error instanceof SimulationError) return adminError(error.status, error.code, 'Fleet scenario input or capture was refused.');
    if (error instanceof TypeError) return adminError(400, 'invalid_fleet_range', 'Select a valid observed history period.');
    return adminError(503, 'fleet_unavailable', 'Fleet evidence is temporarily unavailable. Retry the capture.');
  }
}
