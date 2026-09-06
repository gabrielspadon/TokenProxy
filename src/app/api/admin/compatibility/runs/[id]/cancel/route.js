import { compatibilityResponse } from '@/lib/admin/compatibility';
import { getCompatibilityManager } from '@/lib/compatibility/client';
export const dynamic = 'force-dynamic';
export function POST(request, { params }) { return compatibilityResponse(request, async () => (await getCompatibilityManager()).cancel((await params).id)); }
