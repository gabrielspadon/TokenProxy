import { requireAdmin } from '@/lib/admin/guard';
import { adminJson, adminError } from '@/lib/admin/policy';
import { readInvestigationBody } from '@/lib/admin/investigations';
import { InvestigationError,object } from '@/lib/db/analytics/investigationModel.mjs';
import { validateEvidenceQuery } from '@/lib/db/analytics/evidenceQueries.mjs';
import { getAdapter } from '@/lib/db/driver';
import { DATA_FILE } from '@/lib/db/paths';
import { readContextAnalytics } from '@/lib/db/analytics/client';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const query = validateEvidenceQuery({ ...object(await readInvestigationBody(request),['mode','definition']), operation:'evidence' });
    const writer = await getAdapter();
    const result = await readContextAnalytics(query,{file:DATA_FILE,driver:writer.driver,signal:request.signal});
    if (result.refused) return adminError(413,result.code,result.message,{limits:result.limits,totalRecords:result.totalRecords});
    return adminJson(result);
  } catch (error) {
    return error instanceof InvestigationError ? adminError(error.status,error.code,error.message) : adminError(503,'state_unavailable','Evidence could not be exported. No partial file was produced.');
  }
}
