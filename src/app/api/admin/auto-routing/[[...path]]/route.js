import { requireAdmin } from '@/lib/admin/guard.js';
import { adminJson, adminError } from '@/lib/admin/policy.js';
import { AutoRoutingError, getAutoRouting, getAutoRoutingReceipt, updateAutoRouting } from '@/lib/db/repos/autoRoutingRepo.js';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function handle(request, context) {
  const denied = await requireAdmin(request); if (denied) return denied;
  try {
    const path = (await context?.params)?.path || [];
    if (new URL(request.url).search) throw new AutoRoutingError('invalid_query');
    if (request.method === 'GET' && !path.length) return adminJson(await getAutoRouting());
    if (request.method === 'GET' && path.length === 2 && path[0] === 'receipts') return adminJson(await getAutoRoutingReceipt(path[1]));
    if (request.method === 'POST' && !path.length) {
      const chunks = [], reader = request.body?.getReader(); let size = 0;
      if (reader) try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); throw new AutoRoutingError('body_too_large', 413); } chunks.push(value); } } finally { reader.releaseLock(); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AutoRoutingError('invalid_json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['rules', 'expectedCurrent'].includes(key))) throw new AutoRoutingError('invalid_fields');
      const result = await updateAutoRouting(body);
      return adminJson(result, result.outcome === 'partial' ? 207 : 200);
    }
    return adminError(404, 'route_not_found', 'Automatic routing operation not found.');
  } catch (error) {
    return adminError(error instanceof AutoRoutingError ? error.status : 503, error instanceof AutoRoutingError ? error.code : 'auto_routing_unavailable', 'Automatic routing state could not be read or recorded. Inspect retained state before another mutation.');
  }
}
export const GET = handle;
export const POST = handle;
