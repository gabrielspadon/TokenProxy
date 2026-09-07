import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard.js';
import {
  AccessProfileError,
  deleteAccessProfile,
  updateAccessProfile,
} from '@/lib/db/repos/accessProfilesRepo.js';

export const dynamic = 'force-dynamic';

const store = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// An edit mints a new version. Keys that adopted an earlier one are NOT
// rewritten, so they begin reporting as behind rather than silently changing
// what a live client is allowed to do.
export async function PUT(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    return store({ profile: await updateAccessProfile(id, await request.json()) });
  } catch (error) {
    if (error instanceof AccessProfileError) return store({ error: error.message }, error.status);
    console.log('Error updating access profile:', error);
    return store({ error: 'Failed to update access profile' }, 500);
  }
}

export async function DELETE(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!(await deleteAccessProfile(id))) return store({ error: 'Profile not found' }, 404);
    // Keys that followed it keep every setting they adopted and become
    // hand-managed. Deleting a bundle is not a way to revoke access.
    return store({ deleted: true, keysReleased: true });
  } catch (error) {
    console.log('Error deleting access profile:', error);
    return store({ error: 'Failed to delete access profile' }, 500);
  }
}
