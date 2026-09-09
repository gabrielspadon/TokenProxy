import { compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
import { getCompatibilityManager } from '@/lib/compatibility/client';
import { FORMATS, LIMITS, OWNER_SCOPE, IMPLEMENTATION_VERSION, SCOPES } from '@/lib/compatibility/model.mjs';
export const dynamic = 'force-dynamic';
export function GET(request) { return compatibilityResponse(request, async () => {
  await getCompatibilityManager();
  const store = await getCompatibilityStore();
  return { fixtures: store.listFixtures(), evidence: store.evidence(), regressions: store.regressions(), formats: FORMATS, limits: LIMITS, ownerScope: OWNER_SCOPE, implementationVersion: IMPLEMENTATION_VERSION,
    scopes: [...SCOPES.map(id => ({ id, available: true })), { id: 'authenticated-executor', available: false }, { id: 'complete-gateway', available: false }], evidenceBasis: 'Exact retained fixture, target, scope and implementation outcomes only. No upstream readiness or semantic equivalence is established.' };
}); }
