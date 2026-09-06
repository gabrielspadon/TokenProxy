import { requireAdmin } from '@/lib/admin/guard.js';
import { adminJson, adminError } from '@/lib/admin/policy.js';
import { ShapingError } from '@/lib/shaping/profile.js';
import { shapingCurrent, shapingVersion, shapingList, saveShapingProfile, shapingExperiment, createShapingExperiment, promoteShapingProfile } from '@/lib/db/repos/shapingProfilesRepo.js';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function bodyOf(request, allowed) {
  const chunks = [], reader = request.body?.getReader(); let size = 0;
  if (reader) try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); throw new ShapingError('profile_request_too_large', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ShapingError('invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new ShapingError('invalid_request_fields');
  return body;
}
async function handle(request, context) {
  const denied = await requireAdmin(request); if (denied) return denied;
  try {
    const path = (await context?.params)?.path || [], [resource, id] = path, query = new URL(request.url).searchParams;
    const list = request.method === 'GET' && path.length === 1;
    const allowed = list ? ['page', 'pageSize'] : [];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1 || !/^[1-9]\d*$/.test(query.get(key)))) throw new ShapingError('invalid_query');
    if (request.method === 'GET') {
      if (!path.length) return adminJson(await shapingCurrent());
      if (list) return adminJson(await shapingList(resource, Object.fromEntries([...query].map(([key, value]) => [key, Number(value)]))));
      if (path.length === 2 && resource === 'profiles') return adminJson(await shapingVersion(Number(id)));
      if (path.length === 2 && resource === 'experiments') return adminJson(await shapingExperiment(id));
    }
    if (request.method === 'POST' && path.length === 1) {
      let result;
      if (resource === 'profiles') result = await saveShapingProfile(await bodyOf(request, ['profileId', 'expectedRevision', 'name', 'settings', 'consent']));
      if (resource === 'experiments') result = await createShapingExperiment(await bodyOf(request, ['baselineVersionId', 'candidateVersionId', 'fixtureSetId']), { signal: request.signal });
      if (resource === 'promote') result = await promoteShapingProfile(await bodyOf(request, ['versionId', 'expectedCurrent', 'consent', 'experimentId', 'acknowledgeUnsupported']));
      if (resource === 'rollback') result = await promoteShapingProfile(await bodyOf(request, ['expectedCurrent', 'consent', 'rollbackReceiptId']));
      if (result) return adminJson(result, result.outcome === 'partial' ? 207 : 200);
    }
    return adminError(404, 'shaping_route_not_found', 'Shaping operation not found.');
  } catch (error) {
    if (error instanceof ShapingError) return adminError(error.status, error.code, 'Shaping operation was refused or did not complete.', error.details);
    return adminError(500, 'shaping_unavailable', 'Shaping state could not be read or written.');
  }
}
export const GET = handle;
export const POST = handle;
