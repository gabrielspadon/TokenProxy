import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard.js';
import { publicApiKey } from '@/lib/admin/publicApiKey.js';
import { AccessProfileError } from '@/lib/db/repos/accessProfilesRepo.js';
import { adoptAccessProfile, releaseAccessProfile } from '@/lib/db/repos/keyLifecycleRepo.js';

export const dynamic = 'force-dynamic';

const store = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Adopt a profile: its current version's settings are COPIED onto the key. The
// response is redacted like every other key response; adoption discloses
// nothing new.
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const { profileId } = await request.json();
    if (typeof profileId !== 'string' || !profileId)
      return store({ error: 'profileId is required' }, 400);
    return store({ key: publicApiKey(await adoptAccessProfile(id, profileId)) });
  } catch (error) {
    if (error instanceof AccessProfileError) return store({ error: error.message }, error.status);
    console.log('Error adopting access profile:', error);
    return store({ error: 'Failed to adopt access profile' }, 500);
  }
}

// Stop following a profile. Every adopted setting stays exactly as it is; only
// the claim to be governed by the bundle goes.
export async function DELETE(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const released = await releaseAccessProfile(id);
    if (!released) return store({ error: 'Key not found' }, 404);
    return store({ key: publicApiKey(released) });
  } catch (error) {
    console.log('Error releasing access profile:', error);
    return store({ error: 'Failed to release access profile' }, 500);
  }
}
