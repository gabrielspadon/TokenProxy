import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { ContextAnalyticsError } from '@/lib/db/analytics/client.js';
import { RuleValidationError, dryRunRule } from '@/lib/db/repos/notificationRulesRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Evaluate a rule definition against the RETAINED HISTORICAL POPULATION and
 * report what it would have fired on. Nothing is written, nothing is sent, and
 * no account, route or provider state is touched.
 *
 * POST rather than GET because the rule definition is a structured body, not
 * because this mutates anything.
 */
export async function POST(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return adminError(400, 'invalid_body', 'Send a JSON rule definition.');
  }
  try {
    return adminJson(
      await dryRunRule(body?.rule ?? body, {
        start: body?.start,
        end: body?.end,
        signal: request.signal,
      })
    );
  } catch (error) {
    if (error instanceof RuleValidationError) {
      return adminError(400, 'invalid_rule', error.message);
    }
    if (error instanceof TypeError) {
      return adminError(400, 'invalid_query', 'Select a valid evaluation range.');
    }
    if (error instanceof ContextAnalyticsError) {
      return adminError(
        503,
        'state_unavailable',
        'Rule evidence is busy or temporarily unavailable. Retry shortly.'
      );
    }
    return adminError(500, 'state_unavailable', 'The dry run could not be completed.');
  }
}
