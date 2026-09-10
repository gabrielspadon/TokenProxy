'use client';
import { useMemo } from 'react';
import { useOptionalWorkspace } from './WorkspaceProvider';
import { modelsForAccounts } from './scopeOptions';

// Every model picker on a routing surface offers only what a request could
// actually reach: models of providers with at least one configured account.
// Anything already configured stays selectable even when its provider is gone,
// so an existing choice is never silently dropped from the list.
export function useConfiguredModels(alsoInclude = []) {
  // Optional on purpose: a picker is still useful on a surface mounted outside
  // the workspace shell, it just has no configured population to narrow to.
  const workspace = useOptionalWorkspace();
  const accounts = workspace?.accounts;
  const models = workspace?.models;
  const catalog = models?.data?.models;
  const loading = Boolean(models?.loading) && !catalog;
  const extra = alsoInclude.filter(Boolean).join(' ');
  return useMemo(() => {
    const reachable = modelsForAccounts(catalog || [], accounts || []);
    const values = new Set(
      reachable.map((model) => model.fullModel || `${model.provider}/${model.model}`)
    );
    for (const value of extra ? extra.split(' ') : []) values.add(value);
    return {
      options: [...values].sort((a, b) => a.localeCompare(b)),
      configured: reachable.length > 0,
      loading,
    };
  }, [catalog, accounts, loading, extra]);
}
