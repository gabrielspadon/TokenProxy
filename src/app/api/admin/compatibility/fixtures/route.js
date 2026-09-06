import { compatibilityBody, compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityStore } from '@/lib/db/repos/compatibilityRepo';
export const dynamic = 'force-dynamic';
export function POST(request) { return compatibilityResponse(request, async () => (await getCompatibilityStore()).createFixture(await compatibilityBody(request))); }
