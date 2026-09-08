import { validateRoutePlanSimulation, simulateRoutePlan } from '@/lib/routingPlanSimulation.js';
import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { captureRoutingState, captureRoutePlanState, assertRouteCaptureFresh } from '@/lib/admin/routingCapture.js';
import { SimulationError, SIMULATOR_LIMITS, validateSimulation, simulateRouting } from '@/lib/routingSimulation.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

async function readBody(request, allowed) {
  if (new URL(request.url).search) throw new SimulationError('invalid_query');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > SIMULATOR_LIMITS.bodyBytes)) throw new SimulationError('simulation_too_large', 413);
  const chunks = [], reader = request.body?.getReader();
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > SIMULATOR_LIMITS.bodyBytes) { void reader.cancel().catch(() => {}); throw new SimulationError('simulation_too_large', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SimulationError('invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new SimulationError('invalid_fields');
  return value;
}
export async function POST(request, context) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const operation = (await context?.params)?.operation;
    if (!['capture', 'validate', 'simulate'].includes(operation)) return adminError(404, 'simulation_route_not_found', 'Simulation operation not found.');
    const body = await readBody(request, operation === 'capture' ? ['input', 'sessionHash', 'draft', 'scope'] : ['capture', 'input', 'draft', 'sessionPolicy']);
    if (operation === 'capture') {
      if (body.scope !== undefined && body.scope !== 'route') throw new SimulationError('invalid_capture_scope');
      return adminJson(await (body.scope === 'route' ? captureRoutePlanState(body) : captureRoutingState(body)));
    }
    if (body.capture?.version === 2) {
      const validated = validateRoutePlanSimulation(body);
      await assertRouteCaptureFresh(validated.state);
      if (operation === 'simulate') return adminJson(simulateRoutePlan(body));
      return adminJson({ valid: true, version: 2, captureId: validated.state.captureId, policyVersion: validated.state.policyVersion,
        draftPreview: validated.includeDraft ? { valid: true, accountSimulationAppliesDraft: true } : null });
    }
    if (operation === 'simulate') return adminJson(simulateRouting(body));
    const validated = validateSimulation(body);
    return adminJson({ valid: true, version: validated.state.version, captureId: validated.state.captureId,
      policyVersion: validated.state.policyVersion, draftPreview: validated.draftPreview });
  } catch (error) {
    if (error instanceof SimulationError) return adminError(error.status, error.code, 'Simulation input or captured state was refused.');
    if (error?.name === 'ConfigurationError') return adminError(error.status, 'invalid_draft', 'The routing draft cannot be previewed.');
    return adminError(500, 'simulation_unavailable', 'Routing simulation could not be completed.');
  }
}
