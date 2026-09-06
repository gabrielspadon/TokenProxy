import { investigationResponse, readInvestigationBody } from '@/lib/admin/investigations';
import { InvestigationError, object,validateSave } from '@/lib/db/analytics/investigationModel.mjs';
import { getInvestigationStore } from '@/lib/db/repos/investigationsRepo';
export const dynamic = 'force-dynamic';
export function GET(request,{params}) { return investigationResponse(request, async () => {
  const row = (await getInvestigationStore()).get((await params).id);
  if (!row) throw new InvestigationError('Saved entry not found.',404,'not_found');
  return row;
}); }
export function PUT(request,{params}) { return investigationResponse(request, async () => {
  const input = await readInvestigationBody(request);
  validateSave(input,true);
  return (await getInvestigationStore()).update((await params).id,input);
}); }
export function DELETE(request,{params}) { return investigationResponse(request, async () => {
  const input = object(await readInvestigationBody(request),['version']);
  return (await getInvestigationStore()).remove((await params).id,input.version);
}); }
