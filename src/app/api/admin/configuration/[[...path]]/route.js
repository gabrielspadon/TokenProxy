import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { ConfigurationError } from '@/lib/configuration/routingConfig.js';
import { getCurrentConfiguration, getConfigurationVersion, listConfigurationVersions, listConfigurationReceipts, listConfigurationDrafts, getConfigurationDraft, createConfigurationDraft, reviseConfigurationDraft, validateConfigurationDraft, activateConfigurationDraft, rollbackConfigurationVersion } from '@/lib/db/repos/configVersionsRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

async function bodyOf(request, allowed) {
  const bytes = [], reader = request.body?.getReader();
  let count = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > 262144) { await reader.cancel(); throw new ConfigurationError('configuration_too_large', 413); }
        bytes.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let body;
  try { body = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { throw new ConfigurationError('invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw new ConfigurationError('invalid_request_fields');
  return body;
}
function pagination(request) {
  const q = new URL(request.url).searchParams;
  if ([...q.keys()].some(k => !['before', 'limit'].includes(k))) throw new ConfigurationError('invalid_pagination');
  return { ...(q.has('limit') ? { limit: Number(q.get('limit')) } : {}), ...(q.has('before') ? { before: Number(q.get('before')) } : {}) };
}
async function handle(request, context) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const path = (await context?.params)?.path || [], method = request.method;
    const [resource, id, action] = path;
    if (method === 'GET') {
      if (path.length === 0) return adminJson(await getCurrentConfiguration());
      if (path.length === 1 && resource === 'versions') return adminJson({ versions: await listConfigurationVersions(pagination(request)) });
      if (path.length === 1 && resource === 'receipts') return adminJson({ receipts: await listConfigurationReceipts(pagination(request)) });
      if (path.length === 1 && resource === 'drafts') {
        const options = pagination(request);
        if (new URL(request.url).searchParams.has('before')) options.before = new URL(request.url).searchParams.get('before');
        return adminJson({ drafts: await listConfigurationDrafts(options) });
      }
      if (path.length === 2 && resource === 'versions') return adminJson(await getConfigurationVersion(Number(id)));
      if (path.length === 2 && resource === 'drafts') return adminJson(await getConfigurationDraft(id));
    }
    if (resource === 'drafts') {
      if (method === 'POST' && path.length === 1) return adminJson(await createConfigurationDraft(await bodyOf(request, ['document', 'expectedCurrent'])), 201);
      if (method === 'PATCH' && path.length === 2) return adminJson(await reviseConfigurationDraft(id, await bodyOf(request, ['document', 'expectedRevision'])));
      if (method === 'POST' && path.length === 3 && action === 'validate') return adminJson(await validateConfigurationDraft(id, await bodyOf(request, ['expectedRevision'])));
      if (method === 'POST' && path.length === 3 && action === 'activate') {
        const result = await activateConfigurationDraft(id, await bodyOf(request, ['expectedCurrent', 'expectedRevision']));
        return adminJson(result, result.outcome === 'partial' ? 207 : 200);
      }
    }
    if (method === 'POST' && resource === 'versions' && path.length === 3 && action === 'rollback') {
      const result = await rollbackConfigurationVersion(Number(id), await bodyOf(request, ['expectedCurrent']));
      return adminJson(result, result.outcome === 'partial' ? 207 : 200);
    }
    return adminError(404, 'configuration_route_not_found', 'Configuration operation not found.');
  } catch (error) {
    if (error instanceof ConfigurationError) return adminError(error.status, error.code, 'Configuration operation was refused or did not complete.', error.details);
    return adminError(500, 'configuration_unavailable', 'Configuration state could not be read or written.');
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
