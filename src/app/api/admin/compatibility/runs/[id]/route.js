import { compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
import { getCompatibilityManager } from '@/lib/compatibility/client';
import { CompatibilityError, boundedJson, LIMITS } from '@/lib/compatibility/model.mjs';
export const dynamic = 'force-dynamic';
export function GET(request, { params }) { return compatibilityResponse(request, async () => {
  await getCompatibilityManager();
  const store = await getCompatibilityStore(), run = store.getRun((await params).id);
  if (!run) throw new CompatibilityError('Run not found.', 404, 'not_found');
  const fixture = store.getFixture(run.fixtureId, run.fixtureRevision);
  const result = { run, fixture, manifest: { version: 1, scope: 'local-translation', runId: run.id, fixtureId: fixture.id, fixtureRevision: fixture.revision, fixtureHash: fixture.contentHash, ownerScope: run.ownerScope, createdAt: run.createdAt, finishedAt: run.finishedAt, complete: true, providerCalls: 0 } };
  boundedJson(result, LIMITS.resultBytes + LIMITS.definitionBytes + 16384);
  return result;
}); }
