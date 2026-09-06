import { investigationResponse, readInvestigationBody } from '@/lib/admin/investigations';
import { getInvestigationStore } from '@/lib/db/repos/investigationsRepo';
import { validateSave } from '@/lib/db/analytics/investigationModel.mjs';
export const dynamic = 'force-dynamic';
export function GET(request) { return investigationResponse(request, async () => ({ items: (await getInvestigationStore()).list(), ownerScope: 'installation-operator', limit: 200 })); }
export function POST(request) { return investigationResponse(request, async () => {
  const input = await readInvestigationBody(request);
  validateSave(input);
  return (await getInvestigationStore()).create(input);
}); }
