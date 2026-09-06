'use client';
import { createContext, useCallback, useContext, useState } from 'react';
import { useResource } from './useResource';
import { INITIAL_SCOPE, validateDefinition, validateSelection } from '@/lib/db/analytics/investigationModel.mjs';
export { INITIAL_SCOPE } from '@/lib/db/analytics/investigationModel.mjs';

const WorkspaceContext = createContext(null);
const EMPTY = [];
const INITIAL_CONTEXT = { sessionId: null, page: 1, projectLabel: null, clientTool: null, baseline:null };
const INITIAL_ECONOMICS = { groupBy:'provider', status:'all', sortBy:'timestamp', sortDirection:'desc', cohort:null, groupSortBy:'recordedCostUsd',groupSortDirection:'desc',costSource:'all',attemptKind:'all' };
export function analyticsUrl(scope, view = 'activity', extra = {}) {
  const query = new URLSearchParams({ view, groupBy: 'account', pageSize: '50', ...extra });
  for (const key of ['start', 'end', 'provider', 'model', 'connectionId',...(view==='economics' ? ['sessionId','logicalRequestId','clientRef','projectRef','taskRef','missing'] : [])])
    if (scope[key]) query.set(key, scope[key]);
  return `/api/analytics?${query}`;
}
export function WorkspaceProvider({ children }) {
  const [scope, setScopeValue] = useState(INITIAL_SCOPE);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedRecord, setSelectedRecordValue] = useState(null);
  const [comparisonIds, setComparisonIds] = useState([]);
  const [contextView,setContextValue] = useState(INITIAL_CONTEXT);
  const [economicsView,setEconomicsValue] = useState(INITIAL_ECONOMICS);
  const [savedEntry,setSavedEntry] = useState(null);
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
  const models = useResource('/api/admin/models', { onSnapshot: observeSnapshot });
  const activity = useResource(analyticsUrl(scope), { onSnapshot: observeSnapshot });
  const accounts = health.data?.checks?.connections || EMPTY;
  const selectedAccountId = selectedRecord?.kind === 'account' ? selectedRecord.id : null;
  const setSelectedAccountId = useCallback((id,windowScope=null) => {
    const account = accounts.find((row)=>row.connectionId===id);
    setSelectedRecord(id ? {kind:'account',id,connectionId:id,...(account?.provider ? {provider:account.provider} : {}),...(windowScope ? {windowScope} : {})} : null);
  },[accounts,setSelectedRecord]);
  const setScope = useCallback((patch) => {setScopeValue((old) => ({ ...old, ...patch }));setContextValue((old)=>({...old,page:1}));}, []);
  const refresh = () => {
    health.refresh();
    quota.refresh();
    models.refresh();
    activity.refresh();
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
    selectedAccountId,
    setSelectedAccountId,
    comparisonIds,
    setComparisonIds,
    refresh,
    observeSnapshot,
    selectedRecord,
    setSelectedRecord,
    contextView,
    setContextView,
    economicsView,
    setEconomicsView,
    savedEntry,
    setSavedEntry,
    captureDefinition: (lens) => validateDefinition({schemaVersion:3,lens,scope,selection:selectedRecord,comparisonIds,context:contextView,economics:economicsView}),
    restoreInvestigation: (entry) => {
      const definition = validateDefinition(entry.definition);
      setScopeValue(definition.scope);
      if (entry.kind !== 'filter-set') {
        setSelectedRecordValue(definition.selection); setComparisonIds(definition.comparisonIds);
        setContextValue({...INITIAL_CONTEXT,...definition.context}); setEconomicsValue({...INITIAL_ECONOMICS,...definition.economics});
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
