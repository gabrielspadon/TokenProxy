'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button } from '@mantine/core';
import EconomicsTools from '@/shared/components/workspace/EconomicsTools';
import EconomicsFilters from '@/shared/components/workspace/EconomicsFilters';
import { mergeEconomicsFilters } from '@/lib/db/analytics/investigationModel.mjs';
import EconomicsLens, { EconomicsDetail } from '@/shared/components/workspace/EconomicsLens';
import { useDensity, useLevel } from '@/shared/workspace/Board';
import { groupFilters, groupKey, groupName } from '@/shared/components/workspace/economics';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { analyticsUrl, useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import styles from '@/shared/workspace/workspace.module.css';

export default function EconomicsPage() {
  const router=useRouter(), params=useSearchParams();
  const analysisActive=!['filters','pricing','budgets'].includes(params?.get('tool'));
  const workspace = useWorkspace();
  const { scope, setScope, accounts, observeSnapshot, selectedRecord, setSelectedRecord, economicsView, setEconomicsView, setContextView } = workspace;
  // The sidebar switch owns the level; the density is the one shared choice.
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const groupBy=economicsView.groupBy;
  const setGroupBy=(value)=>setEconomicsView({groupBy:value,cohort:null});
  const selected=economicsView.cohort ? {groupBy,group:economicsView.cohort} : null;
  const setSelected=(value)=>setEconomicsView({cohort:value?.group ? groupFilters(value.group,value.groupBy) : null});
  const [pageState, setPageState] = useState({ key: null, page: 1 });
  const [groupPageState,setGroupPageState]=useState({key:null,page:1});
  const sorting={id:economicsView.sortBy,desc:economicsView.sortDirection==='desc'};
  const setSorting=(value)=>setEconomicsView({sortBy:value.id,sortDirection:value.desc?'desc':'asc'});
  const status=economicsView.status;
  const setStatus=(value)=>setEconomicsView({status:value});
  const groupSorting={id:economicsView.groupSortBy || 'recordedCostUsd',desc:economicsView.groupSortDirection!=='asc'};
  const costSource=economicsView.costSource || 'all', attemptKind=economicsView.attemptKind || 'all';
  let evidenceFilters={}, filterError=null;
  try { evidenceFilters=mergeEconomicsFilters(scope,economicsView); } catch(error){filterError=error.message;}
  const groupKeyScope=analyticsUrl(scope,'economics',{groupBy,...evidenceFilters,groupSortBy:groupSorting.id,groupSortDirection:groupSorting.desc?'desc':'asc'});
  const groupPage=groupPageState.key===groupKeyScope?groupPageState.page:1;
  const scopeKey = analyticsUrl(scope, 'economics', { groupBy,...evidenceFilters,facets:'summary,groups,series,items',pageSize:25,sortBy:'timestamp',sortDirection:'desc',groupPage,groupPageSize:12,groupSortBy:groupSorting.id,groupSortDirection:groupSorting.desc?'desc':'asc' });
  const population = useResource(filterError?null:scopeKey, { onSnapshot: observeSnapshot });
  const retainedGroup = selected?.groupBy === groupBy ? selected.group : null;
  const groupScope = groupFilters(retainedGroup, groupBy) || {};
  let compatible=!filterError;
  try {mergeEconomicsFilters(scope,economicsView,groupScope);}catch{compatible=false;}
  const currentGroup =
    retainedGroup &&
    population.data?.groups?.find(
      (group) => groupKey(group, groupBy) === groupKey(retainedGroup, groupBy)
    );
  const selectedGroup = compatible ? currentGroup || retainedGroup : null;
  const exactRecord=useResource(selectedRecord?.kind==='economics-record' ? analyticsUrl({},'economics',{facets:'items',recordId:selectedRecord.id}) : null,{onSnapshot:observeSnapshot});
  const inspectedFilters=selectedRecord?.kind==='economics-group' ? groupFilters(selectedRecord,selectedRecord.groupBy) : null;
  let inspectionCompatible=inspectedFilters && !filterError;
  try {mergeEconomicsFilters(scope,economicsView,inspectedFilters);}catch{inspectionCompatible=false;}
  const exactGroup=useResource(inspectionCompatible ? analyticsUrl({...scope,...inspectedFilters},'economics',{facets:'groups',groupBy:selectedRecord.groupBy,...evidenceFilters}) : null,{onSnapshot:observeSnapshot});
  const inspectedGroup=exactGroup.data?.groups?.find(group=>groupKey(group,selectedRecord?.groupBy)===selectedRecord?.id);
  const inspected=selectedRecord?.kind==='economics-record' && exactRecord.data?.items?.[0]
    ? {kind:'economics-record',record:exactRecord.data.items[0]}
    : selectedRecord?.kind==='economics-group' ? {kind:'economics-group',group:inspectedGroup || selectedRecord,groupBy:selectedRecord.groupBy} : null;
  const previousScope=Boolean(selectedRecord?.kind==='economics-group' && !inspectionCompatible);
  const setInspection=(inspection)=>{
    const value=inspection?.value;
    if(!value) return setSelectedRecord(null);
    const row=value.record || value.group;
    setSelectedRecord({kind:value.kind,id:value.record?String(row.id):groupKey(row,value.groupBy),
      ...(value.groupBy?{groupBy:value.groupBy}:{}),provider:row.provider,model:row.model,connectionId:row.connectionId,
      ...(row.contextSessionId || row.sessionId ? {sessionId:row.contextSessionId || row.sessionId} : {}),
      ...Object.fromEntries(['logicalRequestId','clientRef','projectRef','taskRef'].filter(key=>row[key]!=null).map(key=>[key,row[key]])),
      ...(Number.isFinite(Date.parse(row.timestamp))?{timestamp:new Date(row.timestamp).toISOString()}:{})});
  };
  const ledgerScope = { ...scope, ...(groupFilters(selectedGroup, groupBy) || {}) };
  const ledgerKey = `${analyticsUrl(ledgerScope, 'economics', { groupBy,...evidenceFilters })}:${sorting.id}:${sorting.desc}:${status}`;
  const page = pageState.key === ledgerKey ? pageState.page : 1;
  const reusePopulation = !selectedGroup && page===1 && sorting.id==='timestamp' && sorting.desc && status==='all';
  const ledger = useResource(
    filterError || reusePopulation?null:analyticsUrl(ledgerScope, 'economics', {
      groupBy,
      ...evidenceFilters,
      facets:'items',
      page,
      pageSize: 25,
      sortBy: sorting.id,
      sortDirection: sorting.desc ? 'desc' : 'asc',
      ...(status === 'all' ? {} : { status }),
    }),
    { onSnapshot: observeSnapshot }
  );
  const ledgerResource=reusePopulation?population:ledger;
  const title =
    inspected?.kind === 'economics-record'
      ? `Completion record ${inspected.record.id}`
      : inspected?.group
        ? groupName(inspected.group, inspected.groupBy, accounts)
        : 'Economics details';
  return (
    <div className={styles.lensViewport} data-density={density}>
      <div className={styles.lensHeading}>
        <div className={styles.lensTitle}>
          <h1>Economics</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · exact cost records, captured rates and attributed work</p>
        </div>
      </div>
      <ScopeBar />
      {filterError && <Alert color="red" mx={24}>{filterError}</Alert>}
      {retainedGroup && !compatible && <Alert color="orange" mx={24}>The retained cohort conflicts with the current filters. Its records are excluded from the current view. Clear the cohort or restore its matching scope before exporting.<Button size="sm" variant="default" mt="sm" onClick={()=>setEconomicsView({cohort:null})}>Clear retained cohort filter</Button></Alert>}
      {selectedRecord?.kind==='economics-record' && exactRecord.error && <Alert color="red" mx={26}>Selected completion evidence could not be read. {exactRecord.error}</Alert>}
      {selectedRecord?.kind==='economics-record' && exactRecord.data?.items?.length===0 && <Alert color="gray" mx={26}>The exact selected completion record is no longer retained. Its identity remains selected; no other record was substituted.</Alert>}
      <EconomicsTools filterCount={Object.keys(economicsView.filters || {}).length} filters={<EconomicsFilters value={economicsView.filters} onChange={filters=>setEconomicsView({filters})}/>}>
        <SelectionDock
          open={analysisActive && Boolean(inspected) && !(!advanced && inspected.kind === 'economics-group')}
          title={title}
          subtitle="Completion ledger · estimates and upstream USD reports"
          onClose={() => setInspection(null)}
          height="100%"
          detail={
            <>
              {previousScope && (
                <Alert color="gray" mb="md">
                  Selected evidence is retained from the previous scope. These details do not
                  contribute to the current comparison.
                </Alert>
              )}
              {selectedRecord?.kind==='economics-group' && exactGroup.error && <Alert color="red">Selected cohort evidence could not be read. {exactGroup.error}</Alert>}
              {selectedRecord?.kind==='economics-group' && exactGroup.loading ? <p role="status">Reading exact contributing cohort…</p> : <EconomicsDetail selection={inspected} accounts={accounts}
                onDrilldown={(nextGroupBy,group)=>{setEconomicsView({groupBy:nextGroupBy,cohort:groupFilters(group,nextGroupBy)});setInspection({value:{kind:'economics-group',group,groupBy:nextGroupBy}});}}
                onContext={row=>{setContextView({sessionId:row.contextSessionId,page:1});setSelectedRecord({kind:'context-attempt',id:row.requestId,sessionId:row.contextSessionId,provider:row.provider,model:row.model,connectionId:row.connectionId});router.push('/dashboard/context');}}/>}
            </>
          }
        >
          <div>
            <EconomicsLens
              data={population.data}
              loading={population.loading}
              error={population.error}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              groupSorting={groupSorting}
              onGroupSortingChange={value=>setEconomicsView({groupSortBy:value.id,groupSortDirection:value.desc?'desc':'asc'})}
              onGroupPageChange={next=>setGroupPageState({key:groupKeyScope,page:next})}
              costSource={costSource}
              onCostSourceChange={value=>setEconomicsView({costSource:value})}
              attemptKind={attemptKind}
              onAttemptKindChange={value=>setEconomicsView({attemptKind:value})}
              ledgerData={ledgerResource.data}
              ledgerLoading={ledgerResource.loading}
              ledgerError={ledgerResource.error}
              selectedGroup={selectedGroup}
              onGroupSelect={(group) => setSelected(group ? { groupBy, group } : null)}
              onPageChange={(next) => setPageState({ key: ledgerKey, page: next })}
              onInspect={(value) => setInspection({ key: scopeKey, value })}
              accounts={accounts}
              ledgerSorting={sorting}
              onLedgerSortingChange={setSorting}
              ledgerStatus={status}
              inspectedRecordId={selectedRecord?.kind === 'economics-record' ? selectedRecord.id : null}
              inspectedGroupId={selectedRecord?.kind === 'economics-group' && selectedRecord.groupBy === groupBy ? selectedRecord.id : null}
              onLedgerStatusChange={setStatus}
              onTimeRangeChange={(start, end) => setScope({ period: 'custom', start, end })}
              onDrilldown={(nextGroupBy, group) => {
                setEconomicsView({ groupBy: nextGroupBy, cohort: groupFilters(group, nextGroupBy) });
                setInspection({ value: { kind: 'economics-group', group, groupBy: nextGroupBy } });
              }}
              advanced={advanced}
              density={density}
              onDensity={setDensity}
              onRefresh={workspace.refresh}
            />
          </div>
        </SelectionDock>
      </EconomicsTools>
    </div>
  );
}
