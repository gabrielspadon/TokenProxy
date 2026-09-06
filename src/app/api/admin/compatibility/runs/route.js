import { compatibilityBody, compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
import { getCompatibilityManager } from '@/lib/compatibility/client';
import { CompatibilityError, identifier, revision, pagination } from '@/lib/compatibility/model.mjs';
export const dynamic = 'force-dynamic';
export function GET(request) { return compatibilityResponse(request, async () => {
  await getCompatibilityManager();
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['page', 'pageSize', 'fixtureId'].includes(key))) throw new CompatibilityError('Unsupported run history filter.');
  return (await getCompatibilityStore()).listRuns({ ...pagination(params), fixtureId: params.get('fixtureId') || undefined });
}); }
export function POST(request) { return compatibilityResponse(request, async () => {
  const body = await compatibilityBody(request);
  if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['fixtureId', 'revision'].includes(key))) throw new CompatibilityError('Only an exact saved fixture ID and revision can start a run.');
  return (await getCompatibilityManager()).submit(identifier(body.fixtureId), revision(body.revision));
}); }
