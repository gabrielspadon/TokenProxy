import { compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
import { getCompatibilityManager } from '@/lib/compatibility/client';
import { FORMATS, LIMITS, OWNER_SCOPE, IMPLEMENTATION_VERSION } from '@/lib/compatibility/model.mjs';
export const dynamic = 'force-dynamic';
export function GET(request) { return compatibilityResponse(request, async () => {
  await getCompatibilityManager();
  const store = await getCompatibilityStore();
  return { fixtures: store.listFixtures(), evidence: store.evidence(), formats: FORMATS, limits: LIMITS, ownerScope: OWNER_SCOPE, implementationVersion: IMPLEMENTATION_VERSION,
    scopes: [{ id: 'local-translation', available: true }, { id: 'authenticated-executor', available: false }, { id: 'complete-gateway', available: false }], evidenceBasis: 'Retained local fixture outcomes only. No upstream readiness or semantic equivalence is established.' };
}); }
