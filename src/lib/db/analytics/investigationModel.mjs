import { ECONOMICS_GROUP_VALUES, economicsGroupKey } from './economicsDimensions.mjs';
export class InvestigationError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export const OWNER_SCOPE = 'installation-operator';
export const LENS_PATHS = { capacity: '/dashboard', context: '/dashboard/context', economics: '/dashboard/usage', routing: '/dashboard/sessions' };
export const INITIAL_SCOPE = { period: 'all', start: null, end: null, provider: null, model: null, connectionId: null };
const kinds = ['account', 'context-session', 'context-attempt', 'economics-record', 'economics-group', 'routing-switch'];
const sorts = ['timestamp','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','recordedCostUsd','latencyMs','ttftMs'];
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new InvestigationError('Unknown or malformed field.');
  return value;
}
export function text(value, name, max = 200, nullable = true) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new InvestigationError(`Invalid ${name}.`);
  return value;
}
function choice(value, choices, fallback) {
  const result = value ?? fallback;
  if (!choices.includes(result)) throw new InvestigationError('Unsupported option.');
  return result;
}
function date(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InvestigationError('Invalid UTC boundary.');
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0,10) !== value.slice(0,10)) throw new InvestigationError('Invalid calendar date.');
  return normalized;
}
export function validateScope(input = INITIAL_SCOPE) {
  const value = object(input, Object.keys(INITIAL_SCOPE));
  const scope = { period: choice(value.period, ['all','24h','7d','custom'], 'all'), start: date(value.start), end: date(value.end),
    provider: text(value.provider, 'provider'), model: text(value.model, 'model'), connectionId: text(value.connectionId, 'account') };
  if (scope.start && scope.end && scope.start >= scope.end) throw new InvestigationError('Start must precede the exclusive end.');
  if (scope.period === 'all' && (scope.start || scope.end)) throw new InvestigationError('All-history scope cannot contain time boundaries.');
  if (scope.period !== 'all' && (!scope.start || !scope.end)) throw new InvestigationError('Saved ranges require fixed start and end boundaries.');
  return scope;
}
export function validateSelection(value) {
  if (value == null) return null;
  object(value, ['kind','id','sessionId','provider','model','connectionId','fromConnectionId','timestamp','groupBy','windowScope','logicalRequestId','clientRef','projectRef','taskRef']);
  const selected = { kind: choice(value.kind, kinds), id: text(String(value.id ?? ''), 'record ID', value.kind === 'economics-group' ? 650 : 200, false) };
  for (const name of ['provider','model','connectionId','fromConnectionId','windowScope']) if (value[name] != null) selected[name] = text(value[name], name);
  for (const name of ['logicalRequestId','clientRef','projectRef','taskRef']) if (value[name]!=null) {
    selected[name]=text(value[name],name,128);
    if(name!=='logicalRequestId' && !/^ctx1_[a-f0-9]{64}$/.test(selected[name])) throw new InvestigationError('Invalid explicit identity reference.');
  }
  if (value.timestamp != null) selected.timestamp = date(value.timestamp);
  if (value.sessionId != null) {
    if (!/^[1-9]\d*$/.test(String(value.sessionId)) || !Number.isSafeInteger(Number(value.sessionId))) throw new InvestigationError('Invalid session ID.');
    selected.sessionId = Number(value.sessionId);
  }
  if (value.kind === 'context-session' && !selected.sessionId) selected.sessionId = Number(selected.id);
  if (value.kind.startsWith('context-') && (!Number.isSafeInteger(selected.sessionId) || selected.sessionId < 1)) throw new InvestigationError('Context selection requires its exact session ID.');
  if (value.kind === 'context-session' && selected.id !== String(selected.sessionId)) throw new InvestigationError('Context identity must match its session ID.');
  if (value.kind === 'economics-record' && (!/^[1-9]\d*$/.test(selected.id) || !Number.isSafeInteger(Number(selected.id)))) throw new InvestigationError('Invalid ledger ID.');
  if (value.kind === 'economics-group') {
    selected.groupBy = choice(value.groupBy, ECONOMICS_GROUP_VALUES);
    const expected=economicsGroupKey(selected,selected.groupBy);
    if(selected.id!==expected)throw new InvestigationError('Cohort identity does not match its dimensions.');
  }
  return selected;
}
export function selectionLens(selected) {
  if (!selected) return null;
  return selected.kind === 'account' ? 'capacity' : selected.kind.startsWith('context-') ? 'context' : selected.kind.startsWith('economics-') ? 'economics' : 'routing';
}
export function selectionExcluded(selected, scope) {
  if (!selected) return false;
  for (const key of ['provider','model','connectionId']) if (scope[key] && selected[key] && scope[key] !== selected[key] && !(key==='connectionId' && selected.kind==='routing-switch' && scope[key]===selected.fromConnectionId)) return true;
  return Boolean(selected.timestamp && ((scope.start && selected.timestamp < scope.start) || (scope.end && selected.timestamp >= scope.end)));
}
export function validateDefinition(value) {
  object(value, ['schemaVersion','lens','scope','selection','comparisonIds','context','economics']);
  if (![1,2,3].includes(value.schemaVersion)) throw new InvestigationError('Unsupported investigation version.');
  const ids = value.comparisonIds ?? [];
  if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) throw new InvestigationError('Compare at most 100 distinct accounts.');
  const context = object(value.context || {}, ['sessionId','page','projectLabel','clientTool',...(value.schemaVersion>=2 ? ['baseline'] : [])]);
  const economics = object(value.economics || {}, ['groupBy','status','sortBy','sortDirection','cohort',...(value.schemaVersion>=3 ? ['groupSortBy','groupSortDirection','costSource','attemptKind'] : [])]);
  const page = context.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new InvestigationError('Invalid attempt page.');
  const selection=validateSelection(value.selection);
  const sessionId = context.sessionId == null ? (selection?.kind.startsWith('context-') ? selection.sessionId : null) : Number(context.sessionId);
  if(selection?.kind.startsWith('context-') && sessionId!==selection.sessionId)throw new InvestigationError('Selected Context identity and view must reference the same session.');
  if (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId < 1)) throw new InvestigationError('Invalid session ID.');
  let cohort = null;
  if (economics.cohort) {
    object(economics.cohort, ['provider','model','connectionId',...(value.schemaVersion>=3 ? ['sessionId','logicalRequestId','clientRef','projectRef','taskRef','missing'] : [])]);
    cohort = Object.fromEntries(Object.entries(economics.cohort).map(([key,item]) => [key,key==='sessionId' ? Number(item) : text(item,key)]));
    if (cohort.sessionId!=null && (!Number.isSafeInteger(cohort.sessionId) || cohort.sessionId<1)) throw new InvestigationError('Invalid explicit session.');
    for(const key of ['clientRef','projectRef','taskRef']) if(cohort[key]!=null && !/^ctx1_[a-f0-9]{64}$/.test(cohort[key])) throw new InvestigationError('Invalid explicit cohort reference.');
    if(cohort.missing && (!['provider','model','connectionId','sessionId','logicalRequestId','clientRef','projectRef','taskRef'].includes(cohort.missing) || cohort[cohort.missing]!=null)) throw new InvestigationError('Invalid missing cohort identity.');
  }
  let baseline = null;
  if (context.baseline != null) {
    object(context.baseline,['id','sessionId']);
    const exact = validateSelection({kind:'context-attempt',...context.baseline});
    baseline = {id:exact.id,sessionId:exact.sessionId};
  }
  return { schemaVersion: value.schemaVersion, lens: choice(value.lens, Object.keys(LENS_PATHS)), scope: validateScope(value.scope), selection,
    comparisonIds: ids.map((id) => text(id,'comparison account',200,false)),
    context: { sessionId, page, projectLabel: text(context.projectLabel,'project label',80), clientTool: text(context.clientTool,'client'), ...(value.schemaVersion>=2 ? {baseline} : {}) },
    economics: { groupBy: choice(economics.groupBy,value.schemaVersion>=3 ? ECONOMICS_GROUP_VALUES : ['provider','model','account'],'provider'), status: choice(economics.status,['all','succeeded','failed','pending'],'all'),
      sortBy: choice(economics.sortBy,sorts,'timestamp'), sortDirection: choice(economics.sortDirection,['asc','desc'],'desc'), cohort,
      ...(value.schemaVersion>=3 ? {groupSortBy:choice(economics.groupSortBy,['records','recordedCostUsd','estimatedCostUsd','reportedCostUsd','averageLatencyMs','inputTokens','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'],'recordedCostUsd'),groupSortDirection:choice(economics.groupSortDirection,['asc','desc'],'desc'),costSource:choice(economics.costSource,['all','application-estimate','provider-reported','unknown'],'all'),attemptKind:choice(economics.attemptKind,['all','initial','additional','unknown'],'all')} : {}) } };
}
export function validateSave(input, updating = false) {
  object(input, ['name','kind','definition', ...(updating ? ['version'] : [])]);
  const kind = choice(input.kind,['investigation','filter-set','bookmark']);
  const definition = validateDefinition(input.definition);
  if (kind === 'bookmark' && !definition.selection) throw new InvestigationError('Select an exact record before saving a bookmark.');
  if (kind === 'bookmark') definition.lens=selectionLens(definition.selection);
  if (kind === 'filter-set') { definition.selection = null; definition.comparisonIds = []; definition.context = { sessionId: null, page: 1, projectLabel: null, clientTool: null, ...(definition.schemaVersion>=2 ? {baseline:null} : {}) }; definition.economics.cohort = null; }
  if (updating && (!Number.isSafeInteger(input.version) || input.version < 1)) throw new InvestigationError('Expected version is required.');
  return { name: text(input.name,'name',80,false).trim(), kind, definition, ...(updating ? { version: input.version } : {}) };
}
