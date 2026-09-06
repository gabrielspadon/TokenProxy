import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { getAdapter } from '@/lib/db/driver.js';
import { DATA_FILE } from '@/lib/db/paths.js';
import { ContextAnalyticsError, readContextAnalytics } from '@/lib/db/analytics/client.js';
import { ActivityQueryError, validateActivityQuery } from '@/lib/db/analytics/activityQueries.mjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const input = Object.create(null);
    input.operation = 'activity';
    for (const [key,value] of params) {
      if (Object.hasOwn(input,key)) throw new ActivityQueryError('Duplicate or reserved analytics parameter.');
      input[key] = value;
    }
    const query = validateActivityQuery(input);
    const writer = await getAdapter();
    return adminJson(await readContextAnalytics(query,{file:DATA_FILE,driver:writer.driver,signal:request.signal}));
  } catch (error) {
    if (error instanceof ActivityQueryError) return adminError(400,'invalid_request',error.message);
    if (error instanceof ContextAnalyticsError) return adminError(503,'state_unavailable','Analytics are busy or temporarily unavailable. Retry shortly.');
    return adminError(500,'state_unavailable','Analytics could not be read.');
  }
}
