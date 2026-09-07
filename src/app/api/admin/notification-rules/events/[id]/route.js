import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import {
  RuleValidationError,
  acknowledgeEvent,
  snoozeEvent,
} from '@/lib/db/repos/notificationRulesRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The only two dispositions an operator can record. Neither changes any
// provider-facing state; both annotate the alert row.
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return adminError(400, 'invalid_body', 'Send a JSON action.');
  }
  if (!['acknowledge', 'snooze'].includes(body?.action)) {
    return adminError(400, 'invalid_action', 'Choose acknowledge or snooze.');
  }
  try {
    if (body.action === 'acknowledge') return adminJson(await acknowledgeEvent(id));
    return adminJson(await snoozeEvent(id, body.until));
  } catch (error) {
    if (error instanceof RuleValidationError) {
      return adminError(400, 'invalid_action', error.message);
    }
    return adminError(500, 'state_unavailable', 'The alert could not be updated.');
  }
}
