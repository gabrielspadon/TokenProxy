import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { CONDITIONS, UNAVAILABLE_CONDITIONS } from '@/lib/notifications/conditions.mjs';
import {
  RuleValidationError,
  createRule,
  listRuleEvents,
  listRules,
} from '@/lib/db/repos/notificationRulesRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const [rules, events] = await Promise.all([listRules(), listRuleEvents({ limit: 200 })]);
    return adminJson({
      rules,
      events,
      // The catalogue travels with the list so the editor cannot offer a
      // condition this build does not actually support, and so an operator
      // sees which conditions are missing and why.
      conditions: Object.values(CONDITIONS),
      unavailableConditions: UNAVAILABLE_CONDITIONS,
    });
  } catch {
    return adminError(500, 'state_unavailable', 'Notification rules could not be read.');
  }
}

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
    return adminJson(await createRule(body), 201);
  } catch (error) {
    if (error instanceof RuleValidationError) {
      return adminError(400, 'invalid_rule', error.message);
    }
    return adminError(500, 'state_unavailable', 'The rule could not be saved.');
  }
}
