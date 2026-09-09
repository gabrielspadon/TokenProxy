'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useResource } from './useResource';
import { ObservationProvider, useObservationPolicy } from './ObservationPolicy';
import { INITIAL_SCOPE, validateDefinition, validateScope, validateSelection } from '@/lib/db/analytics/investigationModel.mjs';
export { INITIAL_SCOPE } from '@/lib/db/analytics/investigationModel.mjs';

const WorkspaceContext = createContext(null);
// One URL search param per scope field plus `compare`; absent means default.
// A hard reload or a shared link restores the investigation from them.
const SCOPE_KEYS = Object.keys(INITIAL_SCOPE);
function scopeFromParams(params) {
  const patch = {};
  for (const key of SCOPE_KEYS) if (params.get(key)) patch[key] = params.get(key);
  const comparisonIds = (params.get('compare') || '').split(',').filter(Boolean);
  const rawSelection = params.get('selected');
  if (!Object.keys(patch).length && !comparisonIds.length && !rawSelection) return null;
  try {
    // The banner promises the selection is retained, so a reload has to keep
    // it too. validateSelection is the same untrusted-input path a saved
    // investigation takes, so a hand-edited link cannot inject a record.
    let selection = null;
    if (rawSelection) selection = validateSelection(JSON.parse(rawSelection));
    const definition = validateDefinition({ schemaVersion: 3, lens: 'capacity', scope: validateScope({ ...INITIAL_SCOPE, ...patch }), comparisonIds, selection });
    return { scope: definition.scope, comparisonIds: definition.comparisonIds, selection };
  } catch {
    return null; // A malformed shared link falls back to the default scope.
  }
}
const EMPTY = [];
const INITIAL_CONTEXT = { sessionId: null, page: 1, projectLabel: null, clientTool: null, baseline:null, intervalComparison:null };
const INITIAL_ECONOMICS = { groupBy:'provider', status:'all', sortBy:'timestamp', sortDirection:'desc', cohort:null, groupSortBy:'recordedCostUsd',groupSortDirection:'desc',costSource:'all',attemptKind:'all',filters:{} };
export function analyticsUrl(scope, view = 'activity', extra = {}) {
  const query = new URLSearchParams({ view, groupBy: 'account', pageSize: '50', ...extra });
  for (const key of ['start', 'end', 'provider', 'model', 'connectionId', 'projectId',...(view==='economics' ? ['sessionId','logicalRequestId','clientRef','projectRef','taskRef','missing'] : [])])
    if (scope[key]) query.set(key, scope[key]);
  return `/api/analytics?${query}`;
}
export function WorkspaceProvider({ children }) {
  return <ObservationProvider><WorkspaceStateProvider>{children}</WorkspaceStateProvider></ObservationProvider>;
}
function WorkspaceStateProvider({ children }) {
  const observations = useObservationPolicy();
  const pathname = usePathname();
  // Read the shared scope through useSearchParams so the server and the first
  // client render agree. Restoring it during render instead made the server
  // emit the default scope and the client the restored one, which React
  // reported as hydration error #418 on every link carrying scope params.
  // useSearchParams is null outside a Next router (unit tests mount the
  // provider directly), so fall back to the live location there.
  const searchParams = useSearchParams();
  const restoredFromUrl = scopeFromParams(searchParams
    || new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search));
  const [scope, setScopeValue] = useState(() => restoredFromUrl?.scope || INITIAL_SCOPE);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedRecord, setSelectedRecordValue] = useState(() => restoredFromUrl?.selection || null);
  const [comparisonIds, setComparisonIds] = useState(() => restoredFromUrl?.comparisonIds || []);
  const [contextView,setContextValue] = useState(INITIAL_CONTEXT);
  const [economicsView,setEconomicsValue] = useState(INITIAL_ECONOMICS);
  const [savedEntry,setSavedEntry] = useState(null);
  const [activityPageState,setActivityPageState]=useState({key:null,page:1});
  const setHistorical = observations.setHistorical;
  const setSnapshotMode = observations.setSnapshot;
  useEffect(() => { setHistorical(Boolean(scope.start || scope.end)); }, [scope.start, scope.end, setHistorical]);
  useEffect(() => { setSnapshotMode(Boolean(snapshot)); }, [snapshot, setSnapshotMode]);
  const setSelectedRecord = useCallback((value) => setSelectedRecordValue(validateSelection(value)),[]);
  const setContextView = useCallback((patch) => setContextValue((previous)=>({...previous,...patch})),[]);
  const setEconomicsView = useCallback((patch) => setEconomicsValue((previous)=>({...previous,...patch})),[]);
  const observeSnapshot = useCallback(
    (next) =>
      setSnapshot((previous) =>
        previous?.capturedAt === next.capturedAt &&
        previous?.isolated === next.isolated &&
        previous?.kind === next.kind
          ? previous
          : next
      ),
    []
  );
  const health = useResource('/api/admin/health/detail', { onSnapshot: observeSnapshot });
  const quota = useResource('/api/admin/quota', { onSnapshot: observeSnapshot });
  const models = useResource('/api/admin/models', { onSnapshot: observeSnapshot, interval: 60000 });
  const activityScopeKey=analyticsUrl(scope);
  const activityGroupPage=activityPageState.key===activityScopeKey?activityPageState.page:1;
  const setActivityGroupPage=page=>setActivityPageState({key:activityScopeKey,page});
  const activity = useResource(activityScopeKey, { onSnapshot: observeSnapshot });
  const pagedInventoryActivity=useResource(activityGroupPage>1?analyticsUrl(scope,'activity',{groupPage:activityGroupPage,groupPageSize:100}):null,{onSnapshot:observeSnapshot});
  const inventoryActivity=activityGroupPage===1?activity:pagedInventoryActivity;
  const accounts = health.data?.checks?.connections || EMPTY;
  const selectedAccountId = selectedRecord?.kind === 'account' ? selectedRecord.id : null;
  const setSelectedAccountId = useCallback((id,windowScope=null,windowId=null) => {
    const account = accounts.find((row)=>row.connectionId===id);
    setSelectedRecord(id ? {kind:'account',id,connectionId:id,...(account?.provider ? {provider:account.provider} : {}),...(windowScope ? {windowScope} : {}),...(windowId ? {windowId} : {})} : null);
  },[accounts,setSelectedRecord]);
  const setScope = useCallback((patch) => {setScopeValue((old) => ({ ...old, ...patch }));setContextValue((old)=>({...old,page:1}));}, []);
  useEffect(() => {
    const restoreHistory=()=>{
      const restored=scopeFromParams(new URLSearchParams(window.location.search));
      setScopeValue(restored?.scope || INITIAL_SCOPE);
      setComparisonIds(restored?.comparisonIds || []);
      setSelectedRecordValue(restored?.selection || null);
    };
    window.addEventListener('popstate',restoreHistory);
    return()=>window.removeEventListener('popstate',restoreHistory);
  },[]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const key of SCOPE_KEYS)
      if (scope[key] && scope[key] !== INITIAL_SCOPE[key]) params.set(key, scope[key]); else params.delete(key);
    if (comparisonIds.length) params.set('compare', comparisonIds.join(',')); else params.delete('compare');
    if (selectedRecord) params.set('selected', JSON.stringify(selectedRecord));
    else params.delete('selected');
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
      window.history.replaceState(window.history.state, '', next);
  }, [scope, comparisonIds, selectedRecord, pathname]);
  const refresh = () => {
    observations.refresh();
  };
  const value = {
    scope,
    setScope,
    snapshot,
    accounts,
    health,
    quota,
    models,
    activity,
    inventoryActivity,
    activityGroupPage,
    setActivityGroupPage,
    selectedAccountId,
    setSelectedAccountId,
    comparisonIds,
    setComparisonIds,
    refresh,
    observations,
    observeSnapshot,
    selectedRecord,
    setSelectedRecord,
    contextView,
    setContextView,
    economicsView,
    setEconomicsView,
    savedEntry,
    setSavedEntry,
    captureDefinition: (lens) => validateDefinition({schemaVersion:5,lens,scope,selection:selectedRecord,comparisonIds,context:contextView,economics:economicsView}),
    restoreInvestigation: (entry) => {
      const definition = validateDefinition(entry.definition);
      setScopeValue(definition.scope);
      if (entry.kind !== 'filter-set') {
        setSelectedRecordValue(definition.selection); setComparisonIds(definition.comparisonIds);
        setContextValue({...INITIAL_CONTEXT,...definition.context}); setEconomicsValue({...INITIAL_ECONOMICS,...definition.economics});
      } else {
        setContextValue((previous) => ({ ...previous, page: 1 }));
        setEconomicsValue({...INITIAL_ECONOMICS,...definition.economics,cohort:null});
      }
      setSavedEntry(entry);
    },
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace() {
  const context = useOptionalWorkspace();
  if (!context) throw new Error('Workspace components require WorkspaceProvider');
  return context;
}
export function useOptionalWorkspace() {
  return useContext(WorkspaceContext);
}
