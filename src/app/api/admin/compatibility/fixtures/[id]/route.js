import { compatibilityBody, compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
import { CompatibilityError } from '@/lib/compatibility/model.mjs';
export const dynamic = 'force-dynamic';
export function GET(request, { params }) { return compatibilityResponse(request, async () => {
  const value = (await getCompatibilityStore()).getFixture((await params).id);
  if (!value) throw new CompatibilityError('Fixture not found.', 404, 'not_found'); return value;
}); }
export function PATCH(request, { params }) { return compatibilityResponse(request, async () => (await getCompatibilityStore()).updateFixture((await params).id, await compatibilityBody(request))); }
