import { getSettings, updateSettings } from '@/lib/localDb';
import { resourceAdmission, validateAdmissionPolicy, startAdmissionSampling } from '@/sse/services/resourceAdmission.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'cache-control': 'no-store' };
// /api/system/* uses dashboardGuard's authenticated, deny-by-default boundary.
export async function GET() {
  const settings = await getSettings();
  if (settings.resourceAdmission) resourceAdmission.configure(settings.resourceAdmission);
  startAdmissionSampling();
  return Response.json(resourceAdmission.snapshot(), { headers });
}
export async function PUT(request) {
  let policy;
  try { policy = validateAdmissionPolicy(await request.json()); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers }); }
  await updateSettings({ resourceAdmission: policy });
  return Response.json(resourceAdmission.configure(policy), { headers });
}
