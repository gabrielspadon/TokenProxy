import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard';
import { CascadePolicyError, getCascadePolicy, replaceCascadePolicy } from '@/lib/db/repos/cascadePolicyRepo.js';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const failure = error => NextResponse.json({ code: error instanceof CascadePolicyError ? error.code : 'cascade_state_unavailable', error: error instanceof CascadePolicyError ? error.code.replaceAll('_', ' ') : 'Cascade policy could not be read or recorded. Read its receipts before another change.' }, { status: error instanceof CascadePolicyError ? error.status : 503, headers });
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try { return NextResponse.json(await getCascadePolicy(), { headers }); } catch (error) { return failure(error); }
}
export async function PUT(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const text = await request.text();
    if (text.length > 70000) throw new CascadePolicyError('body_too_large', 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new CascadePolicyError('invalid_json'); }
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['pairs', 'expectedRevision'].includes(key))) throw new CascadePolicyError('invalid_fields');
    return NextResponse.json(await replaceCascadePolicy(body), { headers });
  } catch (error) { return failure(error); }
}
