import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { ContextAnalyticsError } from '@/lib/db/analytics/client.js';
import { parseQuotaWorkbenchQuery } from '@/lib/db/analytics/quotaWorkbenchQueries.mjs';
import { getQuotaWorkbench } from '@/lib/db/repos/quotaWorkbenchRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  try {
    parseQuotaWorkbenchQuery(params);
  } catch {
    return adminError(400, 'invalid_query', 'Select an account and a valid quota history range.');
  }
  try {
    return adminJson(await getQuotaWorkbench(params, { signal: request.signal }));
  } catch (error) {
    if (error instanceof ContextAnalyticsError)
      return adminError(
        503,
        'state_unavailable',
        'Quota analysis is busy or temporarily unavailable. Retry shortly.'
      );
    return adminError(500, 'state_unavailable', 'Quota analysis could not be read.');
  }
}
