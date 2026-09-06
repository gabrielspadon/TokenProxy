'use client';
import { createContext, useCallback, useContext, useState } from 'react';
import { useResource } from './useResource';

const WorkspaceContext = createContext(null);
const EMPTY = [];
export const INITIAL_SCOPE = {
  period: 'all',
  start: null,
  end: null,
  provider: null,
  model: null,
  connectionId: null,
};
export function analyticsUrl(scope, view = 'activity', extra = {}) {
  const query = new URLSearchParams({ view, groupBy: 'account', pageSize: '50', ...extra });
  for (const key of ['start', 'end', 'provider', 'model', 'connectionId'])
    if (scope[key]) query.set(key, scope[key]);
  return `/api/analytics?${query}`;
}
export function WorkspaceProvider({ children }) {
  const [scope, setScopeValue] = useState(INITIAL_SCOPE);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [comparisonIds, setComparisonIds] = useState([]);
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
  const setScope = useCallback((patch) => setScopeValue((old) => ({ ...old, ...patch })), []);
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
