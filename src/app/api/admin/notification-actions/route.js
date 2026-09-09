import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { getAdapter } from '@/lib/db/driver.js';
import { AUTOMATION_CONDITIONS, AUTOMATION_LIMITS, DRAIN_EFFECT, AutomationError, readActionPolicy, saveActionPolicy, inspectAction, listActions, previewPolicyAgainstHistory, rollbackAction, executeAction } from '@/lib/notifications/remediation.mjs';

export const dynamic = 'force-dynamic';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
async function readBody(request) {
  const declared=request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>16384)) throw new AutomationError('body_too_large',413);
  if (!request.body) throw new AutomationError('body_required');
  const reader=request.body.getReader(), parts=[]; let size=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>16384) { Promise.resolve(reader.cancel()).catch(()=>{}); throw new AutomationError('body_too_large',413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  let body; try { body=JSON.parse(Buffer.concat(parts,size).toString('utf8')); } catch { throw new AutomationError('invalid_json'); }
  if (!body || Array.isArray(body) || typeof body!=='object') throw new AutomationError('invalid_body');
  return body;
}
const failure = error => error instanceof AutomationError
  ? adminError(error.status,error.code,error.code.replaceAll('_',' '))
  : adminError(503,'action_state_unavailable','Action state is unavailable. No automatic retry was sent.');
export async function GET(request) {
  const denied=await requireAdmin(request); if (denied) return denied;
  try {
    const query=new URL(request.url).searchParams, seen=new Set();
    for (const name of query.keys()) {
      if (!['ruleId','actionId','before','limit'].includes(name) || seen.has(name)) throw new AutomationError('invalid_query');
      seen.add(name);
    }
    for (const name of ['ruleId','actionId','before']) if (query.has(name) && !validId(query.get(name))) throw new AutomationError('invalid_identity');
    const db=await getAdapter();
    if (query.has('actionId')) {
      if (seen.size!==1) throw new AutomationError('invalid_query');
      const action=inspectAction(db,query.get('actionId'));
      return action ? adminJson({action}) : adminError(404,'action_not_found','Action not found.');
    }
    const ruleId=query.get('ruleId');
    return adminJson({ policy:ruleId?readActionPolicy(db,ruleId):null,
      ...listActions(db,{ruleId,before:query.get('before'),limit:Number(query.get('limit')||50)}),
      effect:DRAIN_EFFECT,limits:AUTOMATION_LIMITS,conditions:AUTOMATION_CONDITIONS });
  } catch(error) { return failure(error); }
}
export async function POST(request) {
  const denied=await requireAdmin(request); if (denied) return denied;
  try {
    const body=await readBody(request), action=body.action;
    const fields=action==='save-policy'||action==='preview-policy' ? ['action','policy'] : action==='dry-run' ? ['action','actionId'] : action==='rollback' ? ['action','actionId','expectedAfterState'] : [];
    if (!fields.length || Object.keys(body).some(key=>!fields.includes(key))) throw new AutomationError('invalid_action');
    const db=await getAdapter(); let result;
    if (action==='preview-policy') return adminJson(previewPolicyAgainstHistory(db,body.policy));
    if (action==='save-policy') result={policy:saveActionPolicy(db,body.policy),changed:true};
    else {
      if (!validId(body.actionId)) throw new AutomationError('invalid_identity');
      if (action==='dry-run') return adminJson(executeAction(db,body.actionId,{dryRun:true}));
      if (!body.expectedAfterState || typeof body.expectedAfterState!=='object' || Array.isArray(body.expectedAfterState)) throw new AutomationError('expected_state_required');
      result=rollbackAction(db,body.actionId,{expectedAfterState:body.expectedAfterState});
    }
    try { db.flush?.(); }
    catch { return adminJson({...result,persistence:'unconfirmed',error:'Local state changed but durable storage could not be confirmed. Refresh before another action.'},207); }
    return adminJson({...result,persistence:'confirmed'},result.state==='conflict'?409:200);
  } catch(error) { return failure(error); }
}
