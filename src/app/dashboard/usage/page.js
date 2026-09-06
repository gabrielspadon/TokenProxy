'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@mantine/core';
import EconomicsLens, { EconomicsDetail } from '@/shared/components/workspace/EconomicsLens';
import { groupFilters, groupKey, groupName } from '@/shared/components/workspace/economics';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { analyticsUrl, useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import styles from '@/shared/workspace/workspace.module.css';

export default function EconomicsPage() {
  const surface = useRef(null);
  const { scope, setScope, accounts, observeSnapshot, selectedRecord, setSelectedRecord, economicsView, setEconomicsView } = useWorkspace();
  const groupBy=economicsView.groupBy;
  const setGroupBy=(value)=>setEconomicsView({groupBy:value,cohort:null});
  const selected=economicsView.cohort ? {groupBy,group:economicsView.cohort} : null;
  const setSelected=(value)=>setEconomicsView({cohort:value?.group ? groupFilters(value.group,value.groupBy) : null});
  const [pageState, setPageState] = useState({ key: null, page: 1 });
  const sorting={id:economicsView.sortBy,desc:economicsView.sortDirection==='desc'};
  const setSorting=(value)=>setEconomicsView({sortBy:value.id,sortDirection:value.desc?'desc':'asc'});
  const status=economicsView.status;
  const setStatus=(value)=>setEconomicsView({status:value});
  const scopeKey = analyticsUrl(scope, 'economics', { groupBy });
  const population = useResource(scopeKey, { onSnapshot: observeSnapshot });
  const retainedGroup = selected?.groupBy === groupBy ? selected.group : null;
  const groupScope = groupFilters(retainedGroup, groupBy) || {};
  const compatible = Object.entries(groupScope).every(
    ([key, value]) => !scope[key] || scope[key] === value
  );
  const currentGroup =
    retainedGroup &&
    population.data?.groups?.find(
      (group) => groupKey(group, groupBy) === groupKey(retainedGroup, groupBy)
    );
  const selectedGroup = compatible
    ? currentGroup || (population.loading ? retainedGroup : null)
    : null;
  const exactRecord=useResource(selectedRecord?.kind==='economics-record' ? analyticsUrl({},'economics',{recordId:selectedRecord.id}) : null,{onSnapshot:observeSnapshot});
  const inspectedGroup=selectedRecord?.kind==='economics-group' ? population.data?.groups?.find((group)=>groupKey(group,selectedRecord.groupBy)===selectedRecord.id) : null;
  const inspected=selectedRecord?.kind==='economics-record' && exactRecord.data?.items?.[0]
    ? {kind:'economics-record',record:exactRecord.data.items[0]}
    : selectedRecord?.kind==='economics-group' ? {kind:'economics-group',group:inspectedGroup || selectedRecord,groupBy:selectedRecord.groupBy} : null;
  const previousScope=Boolean(selectedRecord?.kind==='economics-group' && !inspectedGroup);
  const setInspection=(inspection)=>{
    const value=inspection?.value;
    if(!value) return setSelectedRecord(null);
    const row=value.record || value.group;
    setSelectedRecord({kind:value.kind,id:value.record?String(row.id):groupKey(row,value.groupBy),
      ...(value.groupBy?{groupBy:value.groupBy}:{}),provider:row.provider,model:row.model,connectionId:row.connectionId,...(Number.isFinite(Date.parse(row.timestamp))?{timestamp:new Date(row.timestamp).toISOString()}:{})});
  };
  const ledgerScope = { ...scope, ...(groupFilters(selectedGroup, groupBy) || {}) };
  const ledgerKey = `${analyticsUrl(ledgerScope, 'economics', { groupBy })}:${sorting.id}:${sorting.desc}:${status}`;
  const page = pageState.key === ledgerKey ? pageState.page : 1;
  const ledger = useResource(
    analyticsUrl(ledgerScope, 'economics', {
      groupBy,
      page,
      pageSize: 25,
      sortBy: sorting.id,
      sortDirection: sorting.desc ? 'desc' : 'asc',
      ...(status === 'all' ? {} : { status }),
    }),
    { onSnapshot: observeSnapshot }
  );
  const title =
    inspected?.kind === 'economics-record'
      ? `Completion record ${inspected.record.id}`
      : inspected?.group
        ? groupName(inspected.group, inspected.groupBy, accounts)
        : 'Economics details';
  useEffect(() => {
    if (!selectedRecord || !selectedRecord.kind.startsWith('economics-')) return;
    const label =
      selectedRecord.kind === 'economics-record' ? 'Recorded requests' : 'Economics by cohort';
    const region = surface.current;
    const table = region?.querySelector(`table[aria-label="${label}"]`);
    if (region && table)
      region.scrollTop += table.getBoundingClientRect().top - region.getBoundingClientRect().top;
  }, [selectedRecord]);
  return (
    <>
      <div className={styles.lensHeading}>
        <div className={styles.lensTitle}>
          <h1>Economics</h1>
          <p>Recorded quantities and application estimates</p>
        </div>
      </div>
      <ScopeBar />
      {selectedRecord?.kind==='economics-record' && exactRecord.error && <Alert color="red" mx={26}>Selected completion evidence could not be read. {exactRecord.error}</Alert>}
      {selectedRecord?.kind==='economics-record' && exactRecord.data?.items?.length===0 && <Alert color="gray" mx={26}>The exact selected completion record is no longer retained. Its identity remains selected; no other record was substituted.</Alert>}
      <div style={{ marginInline: 26 }}>
        <SelectionDock
          open={Boolean(inspected)}
          title={title}
          subtitle="Independent completion ledger · recorded model-rate estimate"
          onClose={() => setInspection(null)}
          height="calc(100dvh - 163px)"
          detail={
            <>
              {previousScope && (
                <Alert color="gray" mb="md">
                  Selected evidence is retained from the previous scope. These details do not
                  contribute to the current comparison.
                </Alert>
              )}
              <EconomicsDetail selection={inspected} accounts={accounts} />
            </>
          }
        >
          <div
            ref={surface}
            style={{
              height: '100%',
              overflow: 'auto',
              border: '1px solid #dce2ec',
              borderRadius: 6,
            }}
          >
            <EconomicsLens
              data={population.data}
              loading={population.loading}
              error={population.error}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              ledgerData={ledger.data}
              ledgerLoading={ledger.loading}
              ledgerError={ledger.error}
              selectedGroup={selectedGroup}
              onGroupSelect={(group) => setSelected(group ? { groupBy, group } : null)}
              onPageChange={(next) => setPageState({ key: ledgerKey, page: next })}
              onInspect={(value) => setInspection({ key: scopeKey, value })}
              accounts={accounts}
              ledgerSorting={sorting}
              onLedgerSortingChange={setSorting}
              ledgerStatus={status}
              onLedgerStatusChange={setStatus}
              onTimeRangeChange={(start, end) => setScope({ period: 'custom', start, end })}
            />
          </div>
        </SelectionDock>
      </div>
    </>
  );
}
