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
  const { scope, setScope, accounts, observeSnapshot } = useWorkspace();
  const [groupBy, setGroupBy] = useState('provider');
  const [selected, setSelected] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [pageState, setPageState] = useState({ key: null, page: 1 });
  const [sorting, setSorting] = useState({ id: 'timestamp', desc: true });
  const [status, setStatus] = useState('all');
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
  const inspected =
    inspection?.value?.kind === 'economics-group' && currentGroup
      ? { ...inspection.value, group: currentGroup }
      : inspection?.value;
  const previousScope = Boolean(
    inspected &&
      inspection.key !== scopeKey &&
      !(inspected.kind === 'economics-group' && currentGroup)
  );
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
    if (!inspection) return;
    const label =
      inspection.value.kind === 'economics-record' ? 'Recorded requests' : 'Economics by cohort';
    surface.current
      ?.querySelector(`table[aria-label="${label}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [inspection]);
  return (
    <>
      <div className={styles.lensHeading}>
        <div className={styles.lensTitle}>
          <h1>Economics</h1>
          <p>Recorded quantities and application estimates</p>
        </div>
      </div>
      <ScopeBar />
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
