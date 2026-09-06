import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard.js';
import {
  AccessProfileError,
  createAccessProfile,
  getAccessProfiles,
} from '@/lib/db/repos/accessProfilesRepo.js';

export const dynamic = 'force-dynamic';

const store = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// A profile holds no credential, so nothing here needs redacting. It is still
// operator-only: the ceilings and allowlists it names are the shape of the
// installation's access policy.
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return store({ profiles: await getAccessProfiles() });
  } catch (error) {
    console.log('Error fetching access profiles:', error);
    return store({ error: 'Failed to fetch access profiles' }, 500);
  }
}

export async function POST(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return store({ profile: await createAccessProfile(await request.json()) }, 201);
  } catch (error) {
    if (error instanceof AccessProfileError) return store({ error: error.message }, error.status);
    console.log('Error creating access profile:', error);
    return store({ error: 'Failed to create access profile' }, 500);
  }
}
