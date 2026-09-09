import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { PROJECT_BINDING_EFFECT } from '../projectIdentity.js';
import { initializeBudgetAccount, outstandingBudget } from './budgetRepo.js';
import { BUDGET_POLICY_EXPLANATIONS, BUDGET_DIMENSIONS } from '../budgetPolicy.js';
import { projectSpendingForecast } from '../projectBudgetEvidence.js';

export class ProjectError extends Error {
  constructor(message, status = 400, code = 'invalid_project', details = {}) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export const PROJECT_POLICY_FIELDS = ['name','archived','maxPromptTokens','maxCompletionTokens','maxCostUsd','budgetPolicy','budgetMode','alertPercent','alertCooldownSeconds'];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const reference = value => typeof value === 'string' && /^ctx1_[a-f0-9]{64}$/.test(value);
const stamp = () => new Date().toISOString();
function fieldsOnly(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field))) throw new ProjectError('Unsupported project fields.');
}
export function validateProjectPolicy(value) {
  fieldsOnly(value, PROJECT_POLICY_FIELDS);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new ProjectError('A project name of 1–80 printable characters is required.');
  const result = { name, archived: value.archived ?? false, budgetPolicy: value.budgetPolicy ?? 'strict', budgetMode: value.budgetMode ?? 'enforce',
    alertPercent: value.alertPercent ?? null, alertCooldownSeconds: value.alertCooldownSeconds ?? 3600 };
  if (typeof result.archived !== 'boolean') throw new ProjectError('archived must be boolean.');
  if (!Object.hasOwn(BUDGET_POLICY_EXPLANATIONS, result.budgetPolicy)) throw new ProjectError('Choose strict or reserve-remaining protection.');
  if (!['enforce','alert'].includes(result.budgetMode)) throw new ProjectError('Choose enforce or alert budget mode.');
  for (const [, limit] of BUDGET_DIMENSIONS) {
    const amount = value[limit] ?? null;
    if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12 || (limit !== 'maxCostUsd' && !Number.isSafeInteger(amount)))) throw new ProjectError('Ceilings require a nonnegative quantity, or null for no ceiling.');
    result[limit] = amount;
  }
  if (result.alertPercent !== null && (typeof result.alertPercent !== 'number' || !Number.isFinite(result.alertPercent) || result.alertPercent < 0 || result.alertPercent > 100)) throw new ProjectError('Alert percent must be between 0 and 100.');
  if (!Number.isSafeInteger(result.alertCooldownSeconds) || result.alertCooldownSeconds < 60 || result.alertCooldownSeconds > 90 * 86400) throw new ProjectError('Alert cooldown must be 60 seconds to 90 days.');
  return result;
}
function currentProject(db, id, expectedRevision) {
  if (!identifier(id)) throw new ProjectError('Invalid project identity.');
  const project = db.get('SELECT * FROM projects WHERE id=?', [id]);
  if (!project) throw new ProjectError('Project not found.', 404, 'project_not_found');
  if (expectedRevision !== undefined) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProjectError('A positive expectedRevision is required.');
    if (expectedRevision !== project.revision) throw new ProjectError('This project changed. Review the current revision before saving.', 409, 'project_conflict', { currentRevision: project.revision });
  }
  return project;
}
const publicProject = project => ({ ...project, archived: Boolean(project.archived),
  budgetExplanation: BUDGET_POLICY_EXPLANATIONS[project.budgetPolicy], bindingEffect: PROJECT_BINDING_EFFECT,
  accountingBasis: 'lifetime-recorded-application-ledger', providerChargeConfirmed: false,
  budgetEffect: project.budgetMode === 'alert' ? 'Records usage and configured alerts; does not refuse requests at the project ceiling. Key limits still apply.' : 'Key and project limits are checked atomically before each covered physical dispatch. Existing streams retain their reservation.' });
function version(db, projectId, change) {
  const project = db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  const bindings = db.all('SELECT * FROM projectBindings WHERE projectId=? ORDER BY id', [projectId]);
  db.run('INSERT INTO projectPolicyVersions(projectId,revision,changedAt,change,document) VALUES(?,?,?,?,?)',
    [projectId, project.revision, project.updatedAt, change, JSON.stringify({ project, bindings })]);
}
function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProjectError('A positive expectedRevision is required.');
}
async function persist(db) { await db.flush?.(); }
export async function createProject(input) {
  const clean = validateProjectPolicy(input), db = await getAdapter(), at = stamp(), id = randomUUID();
  db.transaction(() => {
    const values = { id, ...clean, archived: clean.archived ? 1 : 0, revision: 1, createdAt: at, updatedAt: at };
    db.run(`INSERT INTO projects(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`, Object.values(values));
    initializeBudgetAccount(db, { id }, true);
    version(db, id, 'created');
  });
  await persist(db);
  return getProject(id);
}
export async function updateProject(id, input) {
  fieldsOnly(input, [...PROJECT_POLICY_FIELDS, 'expectedRevision']);
  requireRevision(input.expectedRevision);
  const db = await getAdapter();
  db.transaction(() => {
    const current = currentProject(db, id, input.expectedRevision);
    const patch = Object.fromEntries(Object.entries(input).filter(([field]) => PROJECT_POLICY_FIELDS.includes(field)));
    const clean = validateProjectPolicy({ ...Object.fromEntries(PROJECT_POLICY_FIELDS.map(field => [field, field === 'archived' ? Boolean(current[field]) : current[field]])), ...patch });
    const values = { ...clean, archived: clean.archived ? 1 : 0, revision: current.revision + 1, updatedAt: stamp() };
    db.run(`UPDATE projects SET ${Object.keys(values).map(field => `${field}=?`).join(',')} WHERE id=?`, [...Object.values(values), id]);
    version(db, id, 'updated');
  });
  await persist(db);
  return getProject(id);
}
export async function bindProject(id, input) {
  fieldsOnly(input, ['expectedRevision','apiKeyId','clientRef','projectRef']);
  requireRevision(input.expectedRevision);
  if (!identifier(input.apiKeyId) || !reference(input.clientRef) || !reference(input.projectRef)) throw new ProjectError('An exact authenticated key, client and project reference is required.');
  const db = await getAdapter();
  db.transaction(() => {
    const project = currentProject(db, id, input.expectedRevision);
    if (project.archived) throw new ProjectError('An archived project cannot receive a binding.', 409);
    if (!db.get('SELECT id FROM apiKeys WHERE id=?', [input.apiKeyId])) throw new ProjectError('Client key not found.', 404);
    const params = [input.apiKeyId, input.clientRef, input.projectRef];
    const recorded = db.get("SELECT id FROM usageHistory WHERE clientKeyId=? AND clientRef=? AND projectRef=? AND clientIdentitySource='client-reported' LIMIT 1", params)
      || db.get("SELECT id FROM requestStats WHERE clientKeyId=? AND clientRef=? AND projectRef=? AND clientIdentitySource='client-reported' LIMIT 1", params);
    if (!recorded) throw new ProjectError('This exact authenticated client project has no retained identity evidence.', 422, 'project_identity_unobserved');
    if (db.get('SELECT id FROM projectBindings WHERE apiKeyId=? AND clientRef=? AND projectRef=?', params)) throw new ProjectError('This exact identity is already bound. Remove its current binding explicitly before reassignment.', 409, 'project_binding_conflict');
    if (db.get('SELECT COUNT(*) AS n FROM projectBindings WHERE apiKeyId=?', [input.apiKeyId]).n >= 100) throw new ProjectError('This key already has 100 project bindings.', 409);
    if (db.get('SELECT COUNT(*) AS n FROM projectBindings WHERE projectId=?', [id]).n >= 100) throw new ProjectError('This project already has 100 client bindings.', 409);
    db.run('INSERT INTO projectBindings(id,projectId,apiKeyId,clientRef,projectRef,createdAt) VALUES(?,?,?,?,?,?)', [randomUUID(), id, ...params, stamp()]);
    db.run('UPDATE projects SET revision=revision+1,updatedAt=? WHERE id=?', [stamp(), id]);
    version(db, id, 'bound');
  });
  await persist(db);
  return getProject(id);
}
export async function unbindProject(id, bindingId, input) {
  fieldsOnly(input, ['expectedRevision']); requireRevision(input.expectedRevision);
  if (!identifier(bindingId)) throw new ProjectError('Invalid binding identity.');
  const db = await getAdapter();
  db.transaction(() => {
    currentProject(db, id, input.expectedRevision);
    if (!db.get('SELECT id FROM projectBindings WHERE id=? AND projectId=?', [bindingId, id])) throw new ProjectError('Binding not found.', 404);
    db.run('DELETE FROM projectBindings WHERE id=? AND projectId=?', [bindingId, id]);
    db.run('UPDATE projects SET revision=revision+1,updatedAt=? WHERE id=?', [stamp(), id]);
    version(db, id, 'unbound');
  });
  await persist(db);
  return getProject(id);
}
export function projectPagination({ limit = 50, before = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== null && !identifier(before))) throw new ProjectError('Invalid project pagination.');
  return { limit, before };
}
export async function listProjects(options = {}) {
  const { limit, before } = projectPagination(options), db = await getAdapter();
  const rows = db.all('SELECT * FROM projects WHERE (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?', [before, before, limit + 1]);
  const items = rows.slice(0, limit).map(publicProject);
  return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
}
export async function getProject(id, options = {}) {
  const { limit, before } = projectPagination(options), db = await getAdapter();
  return db.transaction(() => {
    const project = currentProject(db, id), account = db.get('SELECT * FROM projectBudgetAccounts WHERE projectId=?', [id]) ?? null;
    const held = outstandingBudget(db, id, true);
    const rows = db.all('SELECT requestId,logicalRequestId,apiKeyId,createdAt,state,projectPolicyRevision,projectBudgetMode,projectBudgetPolicy,projectReservedPromptTokens,projectReservedCompletionTokens,projectReservedCostUsd,actualPromptTokens,actualCompletionTokens,actualCostUsd,usageRowId,resolutionEvidence FROM apiKeyBudgetReservations WHERE projectId=? AND (? IS NULL OR requestId<?) ORDER BY requestId DESC LIMIT ?', [id, before, before, limit + 1]);
    const reservations = rows.slice(0, limit);
    const asOf = Date.now(), end = new Date(Math.floor(asOf / 3600000) * 3600000).toISOString(), start = new Date(Date.parse(end) - 24 * 3600000).toISOString();
    const hours = db.all('SELECT * FROM projectBudgetUsageHours WHERE projectId=? AND hour>=? AND hour<? ORDER BY hour', [id, start, end]);
    return { project: publicProject(project), account, outstanding: held,
      bindings: db.all('SELECT * FROM projectBindings WHERE projectId=? ORDER BY id', [id]),
      reservations, nextCursor: rows.length > limit ? reservations.at(-1).requestId : null,
      forecast: projectSpendingForecast(project, account, hours, asOf),
      asOf: new Date(asOf).toISOString(), durableStorage: ['better-sqlite3','node:sqlite','bun:sqlite'].includes(db.driver) };
  });
}
export async function listProjectVersions(id, { limit = 50, before = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) throw new ProjectError('Invalid version pagination.');
  const db = await getAdapter(); currentProject(db, id);
  const rows = db.all('SELECT * FROM projectPolicyVersions WHERE projectId=? AND revision<? ORDER BY revision DESC LIMIT ?', [id, before, limit + 1]);
  return { items: rows.slice(0, limit).map(row => ({ ...row, document: JSON.parse(row.document) })), nextCursor: rows.length > limit ? rows[limit - 1].revision : null };
}
export async function listProjectAlerts(id, options = {}) {
  const { limit, before } = projectPagination(options), db = await getAdapter(); currentProject(db, id);
  const rows = db.all('SELECT * FROM projectBudgetAlerts WHERE projectId=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?', [id, before, before, limit + 1]);
  return { items: rows.slice(0, limit).map(({ notificationTargets, ...row }) => {
    let targets;
    try { targets = JSON.parse(notificationTargets); } catch { targets = null; }
    const notificationStatus = !Array.isArray(targets) ? 'authorization-unknown' : targets.length === 0 ? 'not-subscribed'
      : row.notificationQueuedAt ? 'delivery-prepared' : row.notificationErrorCode ? 'preparation-retrying' : 'preparation-pending';
    return { ...row, evidence: JSON.parse(row.evidence), notificationStatus };
  }), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}

export async function listProjectCandidates(apiKeyId, options = {}) {
  if (!identifier(apiKeyId)) throw new ProjectError('Choose an exact client key.');
  const { limit, before } = projectPagination(options);
  const db = await getAdapter();
  if (!db.get('SELECT id FROM apiKeys WHERE id=?', [apiKeyId])) throw new ProjectError('Client key not found.', 404);
  // Candidate IDs are two fixed-length fingerprints, ordered before pagination.
  // No caller-supplied SQL, raw metadata, or secret enters this projection.
  const rows = db.all(`WITH identities AS (
      SELECT clientRef,projectRef FROM usageHistory WHERE clientKeyId=? AND clientIdentitySource='client-reported'
      UNION SELECT clientRef,projectRef FROM requestStats WHERE clientKeyId=? AND clientIdentitySource='client-reported')
    SELECT clientRef,projectRef FROM identities WHERE length(clientRef)=69 AND length(projectRef)=69
      AND substr(clientRef,1,5)='ctx1_' AND substr(projectRef,1,5)='ctx1_'
      AND substr(clientRef,6) NOT GLOB '*[^a-f0-9]*' AND substr(projectRef,6) NOT GLOB '*[^a-f0-9]*'
      AND (? IS NULL OR substr(projectRef,6)||substr(clientRef,6)>?)
    ORDER BY projectRef,clientRef LIMIT ?`, [apiKeyId, apiKeyId, before, before, limit + 1]);
  const items = rows.slice(0, limit).map(row => ({ ...row, apiKeyId, identityBasis: 'authenticated-client-report' }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit ? `${last.projectRef.slice(5)}${last.clientRef.slice(5)}` : null,
    bindingEffect: PROJECT_BINDING_EFFECT };
}
