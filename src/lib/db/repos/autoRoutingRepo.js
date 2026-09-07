import { createHash, randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { parseJson, stringifyJson } from '../helpers/jsonCol.js';
import { splitModelId } from '../../../shared/services/modelTiers.js';

const CLASSES = ['simple', 'coding', 'reasoning'];
const scope = 'Automatic routing targets only; outside routing-plan and shaping-profile rollback.';
export class AutoRoutingError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function rawSettings(db) {
  const raw = parseJson(db.get('SELECT data FROM settings WHERE id=1')?.data, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AutoRoutingError('settings_unreadable', 503);
  return raw;
}
const rulesOf = settings => Object.fromEntries(CLASSES.map(key => [key, typeof settings.autoRouter?.rules?.[key] === 'string' ? settings.autoRouter.rules[key] : null]));
const hash = rules => createHash('sha256').update(JSON.stringify(CLASSES.map(key => [key, rules[key]]))).digest('hex');
export async function getAutoRouting() {
  const db = await getAdapter(), rules = rulesOf(rawSettings(db));
  const receipts = db.all('SELECT value FROM kv WHERE scope=? ORDER BY json_extract(value,\'$.createdAt\') DESC,key LIMIT 20', ['autoRoutingReceipts']).map(row => parseJson(row.value));
  return { rules, currentHash: hash(rules), receipts, scope, receiptLimit: 20 };
}
export async function getAutoRoutingReceipt(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new AutoRoutingError('invalid_receipt_id');
  const db = await getAdapter(), row = db.get('SELECT value FROM kv WHERE scope=? AND key=?', ['autoRoutingReceipts', id]);
  if (!row) throw new AutoRoutingError('receipt_not_found', 404);
  return parseJson(row.value);
}
export async function updateAutoRouting({ rules, expectedCurrent }) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length !== 3 || Object.keys(rules).some(key => !CLASSES.includes(key))) throw new AutoRoutingError('invalid_rule_fields');
  if (Object.values(rules).some(value => value !== null && (typeof value !== 'string' || value.length > 512 || /\s/.test(value) || !splitModelId(value)))) throw new AutoRoutingError('invalid_rule_target');
  if (typeof expectedCurrent !== 'string' || !/^[a-f0-9]{64}$/.test(expectedCurrent)) throw new AutoRoutingError('expected_current_required');
  const db = await getAdapter();
  const result = db.transaction(() => {
    const raw = rawSettings(db), before = rulesOf(raw), beforeHash = hash(before);
    if (beforeHash !== expectedCurrent) throw new AutoRoutingError('auto_routing_conflict', 409);
    const after = Object.fromEntries(CLASSES.map(key => [key, rules[key]])), afterHash = hash(after);
    if (beforeHash === afterHash) return { outcome: 'unchanged', currentHash: afterHash, rules: after };
    if (raw.autoRouter != null && (typeof raw.autoRouter !== 'object' || Array.isArray(raw.autoRouter))) throw new AutoRoutingError('auto_routing_unreadable', 422);
    const updatedRules = { ...raw.autoRouter?.rules };
    for (const key of CLASSES) { if (after[key] === null) delete updatedRules[key]; else updatedRules[key] = after[key]; }
    const receipt = { id: randomUUID(), createdAt: new Date().toISOString(), before, after, beforeHash, afterHash, scope };
    db.run('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [stringifyJson({ ...raw, autoRouter: { ...raw.autoRouter, rules: updatedRules } })]);
    db.run('INSERT INTO kv(scope,key,value) VALUES(?,?,?)', ['autoRoutingReceipts', receipt.id, stringifyJson(receipt)]);
    return { outcome: 'applied', rules: after, currentHash: afterHash, receipt };
  });
  try { db.flush?.(); return { ...result, persistence: 'confirmed' }; }
  catch { return { ...result, outcome: 'partial', persistence: 'unconfirmed' }; }
}
