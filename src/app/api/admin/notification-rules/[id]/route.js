import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import {
  RuleConflictError,
  RuleValidationError,
  deleteRule,
  getRule,
  getRuleVersions,
  listRuleEvents,
  updateRule,
} from '@/lib/db/repos/notificationRulesRepo.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// A conflict is 409 carrying the live rule, so the surface can show what
// changed underneath the operator rather than reporting a generic failure.
function conflict(error) {
  return adminError(409, 'revision_conflict', error.message, {
    expectedRevision: error.expected,
    current: error.actual,
  });
}

export async function GET(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    const rule = await getRule(id);
    if (!rule) return adminError(404, 'not_found', 'This rule no longer exists.');
    const [versions, events] = await Promise.all([
      getRuleVersions(id),
      listRuleEvents({ ruleId: id, limit: 200 }),
    ]);
    return adminJson({ rule, versions, events });
  } catch {
    return adminError(500, 'state_unavailable', 'This rule could not be read.');
  }
}

export async function PUT(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return adminError(400, 'invalid_body', 'Send a JSON rule definition.');
  }
  if (!Number.isInteger(body?.revision)) {
    return adminError(400, 'invalid_rule', 'State the revision you edited.');
  }
  try {
    return adminJson(await updateRule(id, body.revision, body));
  } catch (error) {
    if (error instanceof RuleConflictError) return conflict(error);
    if (error instanceof RuleValidationError) {
      return adminError(400, 'invalid_rule', error.message);
    }
    return adminError(500, 'state_unavailable', 'The rule could not be saved.');
  }
}

export async function DELETE(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const revision = Number(new URL(request.url).searchParams.get('revision'));
  if (!Number.isInteger(revision)) {
    return adminError(400, 'invalid_rule', 'State the revision you are deleting.');
  }
  try {
    return adminJson(await deleteRule(id, revision));
  } catch (error) {
    if (error instanceof RuleConflictError) return conflict(error);
    if (error instanceof RuleValidationError) {
      return adminError(404, 'not_found', error.message);
    }
    return adminError(500, 'state_unavailable', 'The rule could not be deleted.');
  }
}
