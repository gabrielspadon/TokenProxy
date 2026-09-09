import { requireAdmin } from '@/lib/admin/guard.js';
import { adminJson, adminError } from '@/lib/admin/policy.js';
import { ProjectError, createProject, updateProject, bindProject, unbindProject, listProjects,
  getProject, listProjectVersions, listProjectAlerts, listProjectCandidates } from '@/lib/db/repos/projectsRepo.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ProjectError('JSON body is required.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); throw new ProjectError('Project request exceeds 32 KiB.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProjectError('Invalid JSON body.'); }
}
function queryOptions(request, { versions = false, candidates = false } = {}) {
  const query = new URL(request.url).searchParams, seen = new Set();
  for (const key of query.keys()) {
    if (!['before','limit', ...(candidates ? ['apiKeyId'] : [])].includes(key) || seen.has(key)) throw new ProjectError('Unknown or duplicate project query field.');
    seen.add(key);
  }
  const rawLimit = query.get('limit');
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) throw new ProjectError('Invalid page size.');
  const rawBefore = query.get('before');
  if (versions && rawBefore !== null && !/^\d+$/.test(rawBefore)) throw new ProjectError('Invalid version cursor.');
  return { ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
    ...(rawBefore !== null ? { before: versions ? Number(rawBefore) : rawBefore } : {}) };
}
async function handle(request, context) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const path = (await context?.params)?.path || [], [id, resource, member] = path;
    if (request.method === 'GET') {
      if (!path.length) return adminJson(await listProjects(queryOptions(request)));
      if (path.length === 1 && id === 'candidates') return adminJson(await listProjectCandidates(new URL(request.url).searchParams.get('apiKeyId'), queryOptions(request, { candidates: true })));
      if (path.length === 1) return adminJson(await getProject(id, queryOptions(request)));
      if (path.length === 2 && resource === 'versions') return adminJson(await listProjectVersions(id, queryOptions(request, { versions: true })));
      if (path.length === 2 && resource === 'alerts') return adminJson(await listProjectAlerts(id, queryOptions(request)));
    }
    if (new URL(request.url).searchParams.size) throw new ProjectError('Project mutations do not accept query fields.');
    if (request.method === 'POST' && !path.length) return adminJson(await createProject(await readBody(request)), 201);
    if (request.method === 'PATCH' && path.length === 1) return adminJson(await updateProject(id, await readBody(request)));
    if (request.method === 'POST' && path.length === 2 && resource === 'bindings') return adminJson(await bindProject(id, await readBody(request)));
    if (request.method === 'DELETE' && path.length === 3 && resource === 'bindings') return adminJson(await unbindProject(id, member, await readBody(request)));
    return adminError(404, 'project_route_not_found', 'Project operation not found.');
  } catch (error) {
    if (error instanceof ProjectError) return adminError(error.status, error.code, error.message, error.details);
    return adminError(503, 'project_state_unavailable', 'Project state could not be read or saved. Refresh before retrying a change.');
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
