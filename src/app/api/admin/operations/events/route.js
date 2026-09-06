import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { ContextAnalyticsError } from '@/lib/db/analytics/client.js';
import { parseOperationEventsQuery } from '@/lib/db/analytics/operationEventsQueries.mjs';
import { getOperationEvents } from '@/lib/db/repos/operationEventsRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  try {
    parseOperationEventsQuery(params);
  } catch {
    return adminError(400, 'invalid_query', 'Select a valid operation history range.');
  }
  try {
    return adminJson(await getOperationEvents(params, { signal: request.signal }));
  } catch (error) {
    if (error instanceof ContextAnalyticsError)
      return adminError(
        503,
        'state_unavailable',
        'Operation history is busy or temporarily unavailable. Retry shortly.'
      );
    return adminError(500, 'state_unavailable', 'Operation history could not be read.');
  }
}
