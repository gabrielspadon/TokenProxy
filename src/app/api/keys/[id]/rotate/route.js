import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard.js';
import { recordOperationTerminal } from '@/lib/db/repos/operationEventsRepo.js';
import { RotationError, rotateApiKey } from '@/lib/db/repos/keyLifecycleRepo.js';

export const dynamic = 'force-dynamic';

const store = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Issue a successor secret with an operator-chosen overlap window.
 *
 * The response carries the new secret ONCE, exactly as key creation does, and
 * the audit row records that a rotation happened without carrying either
 * secret. The predecessor is never silently invalidated: it expires at the end
 * of the window, and that deadline is in the response.
 */
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    // No default. An overlap window is the operator's decision about how long a
    // client that has not been reconfigured keeps working, and picking one for
    // them is picking when their traffic breaks.
    if (body?.overlapHours === undefined) return store({ error: 'overlapHours is required' }, 400);

    const result = await rotateApiKey(id, body);
    await recordOperationTerminal(
      {
        operationId: randomUUID(),
        phase: 'authentication',
        source: 'api-key-rotation',
        actorClass: 'operator',
        subjectKind: 'apiKey',
        subjectId: id,
      },
      {
        state: 'succeeded',
        code: 'credential_rotated',
        details: { kind: 'credential-rotation', reason: 'explicit-operator-request' },
      }
    );
    return store(result, 201);
  } catch (error) {
    if (error instanceof RotationError) return store({ error: error.message }, error.status);
    console.log('Error rotating key:', error);
    return store({ error: 'Failed to rotate key' }, 500);
  }
}
