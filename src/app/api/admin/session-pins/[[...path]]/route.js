import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { previewPinChange } from '@/lib/admin/sessionPins.js';
import { ContextAnalyticsError } from '@/lib/db/analytics/client.js';
import { PIN_TIMELINE_REQUEST_PARAMS } from '@/lib/db/analytics/sessionPinTimelineQueries.mjs';
import {
  listSessionPins,
  getSessionPinAction,
  applySessionPin,
  PinControlError,
} from '@/lib/db/repos/sessionPinsRepo.js';
import { getSessionPinTimeline } from '@/lib/db/repos/sessionPinTimelineRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
async function bodyOf(request, fields) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768))
    throw new PinControlError('body_too_large', 413);
  const reader = request.body?.getReader(),
    chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) {
          void reader.cancel().catch(() => {});
          throw new PinControlError('body_too_large', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PinControlError('invalid_json');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !fields.includes(k))
  )
    throw new PinControlError('invalid_fields');
  return body;
}
async function handle(request, context) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const path = (await context?.params)?.path || [],
      query = new URL(request.url).searchParams;
    const listFilters = ['provider', 'connectionId', 'model', 'lastSeenFrom', 'lastSeenTo'];
    // Each route names the parameters it accepts. An unknown parameter, a
    // repeat of an accepted one, or any query at all on a route that takes
    // none, is refused before state is read.
    const timeline = path.length === 1 && path[0] === 'timeline' && request.method === 'GET';
    const accepted = timeline
      ? PIN_TIMELINE_REQUEST_PARAMS
      : !path.length && request.method === 'GET'
        ? ['limit', 'before', ...listFilters]
        : [];
    if ([...query.keys()].some((k) => !accepted.includes(k) || query.getAll(k).length !== 1))
      throw new PinControlError('invalid_query');
    if (timeline) return adminJson(await getSessionPinTimeline(query, { signal: request.signal }));
    if (!path.length && request.method === 'GET') {
      if (query.has('before') && !query.get('before')) throw new PinControlError('invalid_cursor');
      if (query.has('limit') && !/^[1-9]\d?$/.test(query.get('limit')))
        throw new PinControlError('invalid_limit');
      return adminJson(
        await listSessionPins({
          ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
          ...(query.has('before') ? { before: query.get('before') } : {}),
          ...Object.fromEntries(
            listFilters.filter((k) => query.has(k)).map((k) => [k, query.get(k)])
          ),
        })
      );
    }
    if (path.length === 2 && path[0] === 'actions' && request.method === 'GET')
      return adminJson(await getSessionPinAction(path[1]));
    if (path.length === 1 && path[0] === 'preview' && request.method === 'POST')
      return adminJson(
        await previewPinChange(
          await bodyOf(request, [
            'id',
            'pinId',
            'expectedRevision',
            'action',
            'targetConnectionId',
            'deadline',
          ])
        )
      );
    if (path.length === 1 && path[0] === 'apply' && request.method === 'POST') {
      const receipt = await applySessionPin(await bodyOf(request, ['id', 'expectedRevision']));
      return adminJson(receipt, receipt.status === 'conflict' ? 409 : 200);
    }
    return adminError(404, 'pin_route_not_found', 'Pin control operation not found.');
  } catch (error) {
    if (error instanceof PinControlError)
      return adminError(error.status, error.code, 'Pin control input or state was refused.');
    if (error instanceof ContextAnalyticsError)
      return adminError(
        503,
        'state_unavailable',
        'Pin history is busy or temporarily unavailable. Retry shortly.'
      );
    if (error?.name === 'SimulationError')
      return adminError(
        error.status || 422,
        'pin_topology_unavailable',
        'This pin topology cannot be previewed.'
      );
    return adminError(500, 'pin_control_unavailable', 'Pin state could not be read or changed.');
  }
}
export const GET = handle;
export const POST = handle;
