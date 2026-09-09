import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { getQuotaCheckQueue } from '@/lib/db/repos/quotaCheckQueue.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const options = {};
    const allowed = new Set(['connectionId','provider','status','page','pageSize']);
    for (const [name,value] of new URL(request.url).searchParams) {
      if (!allowed.has(name) || Object.hasOwn(options,name)) throw new TypeError('Invalid schedule query');
      if (['page','pageSize'].includes(name) && !/^[1-9]\d*$/.test(value)) throw new TypeError('Invalid schedule page');
      options[name] = ['page','pageSize'].includes(name) ? Number(value) : value;
    }
    const queue = await getQuotaCheckQueue();
    return adminJson({ ...queue.list(options), asOf: new Date().toISOString(),
      purpose: 'Metadata checks. Warming remains a separate, explicitly enabled action.' });
  } catch (error) {
    if (error instanceof TypeError) return adminError(400,'invalid_query','Invalid schedule filters or pagination.');
    return adminError(503,'state_unavailable','The quota schedule could not be read.');
  }
}
