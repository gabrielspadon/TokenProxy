'use client';
import { useEffect, useMemo, useState } from 'react';
import { SegmentedControl } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { orderQuotaWindows } from '@/shared/workspace/QuotaEvidence';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './capacity.module.css';
import { AccountBoard } from './AccountBoard';
import { CapacityActivity } from './CapacityActivity';
import { CapacityAnalysis } from './CapacityAnalysis';
import { CapacityModelSupport } from './CapacityModelSupport';
import { DRAIN_ENDPOINT } from './capacityControlsModel';

const EMPTY = [];
const VIEWS = [
  { value: 'accounts', label: 'Accounts' },
  { value: 'analysis', label: 'Activity & analysis' },
  { value: 'support', label: 'Model support' },
];

export default function CapacityPage() {
  const workspace = useWorkspace();
  const { accounts, quota, snapshot, setSelectedAccountId } = workspace;
  const drains = useResource(DRAIN_ENDPOINT, { onSnapshot: workspace.observeSnapshot });
  // The sidebar switch owns the level. Everyday is compact progress cards with
  // pause, rename and expand; Advanced is the dense board with every control.
  const [navigationMode] = useLocalStorage({
    key: 'tokenproxy.navigation-mode',
    defaultValue: 'everyday',
  });
  const [density, setDensity] = useLocalStorage({
    key: 'tokenproxy.capacity-density',
    defaultValue: 'tidy',
  });
  const advanced = navigationMode === 'advanced';
  const [view, setView] = useState('accounts');
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const activity = workspace.inventoryActivity || workspace.activity;
  // The anchor is the moment the evidence describes: the snapshot's capture,
  // else the quota read, else the clock, so a history read never asks for an
  // epoch-zero range while the first quota read is still in flight.
  const anchor = snapshot?.capturedAt
    ? Date.parse(snapshot.capturedAt)
    : quota.data?.asOf
      ? Date.parse(quota.data.asOf)
      : clock;
  const now = snapshot?.isolated && snapshot?.capturedAt ? anchor : clock;
  const rows = useMemo(
    () =>
      accounts.map((account) => {
        const windows =
          quota.data?.snapshots?.find((item) => item.connectionId === account.connectionId)
            ?.windows || EMPTY;
        const record = activity.data?.groups?.find(
          (item) => item.connectionId === account.connectionId
        );
        return {
          ...account,
          drain: !drains.error
            ? drains.data?.connections?.find((item) => item.connectionId === account.connectionId)
            : null,
          windows,
          primary: orderQuotaWindows(windows)[0],
          activity: record,
          activityState: activity.loading
            ? 'Loading activity…'
            : activity.error
              ? 'Activity unavailable'
              : !record && activity.data?.groupPagination?.totalPages > 1
                ? 'Not on this activity page'
                : null,
          records: record?.records ?? -1,
        };
      }),
    [
      accounts,
      quota.data,
      activity.data,
      activity.loading,
      activity.error,
      drains.data,
      drains.error,
    ]
  );
  // The two read views hand a chosen account back to the board, expanded.
  const select = (id, windowScope = null) => {
    setSelectedAccountId(id, windowScope);
    setView('accounts');
  };
  return (
    <div className={styles.page} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Capacity</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · every account, its quota and its controls</p>
        </div>
        <SegmentedControl
          size="xs"
          aria-label="Capacity view"
          value={view}
          onChange={setView}
          data={VIEWS}
          className={styles.views}
        />
      </div>
      <ScopeBar showRefresh={view !== 'accounts'} />
      {view !== 'support' && <CapacityActivity />}
      <div className={styles.boardWrap}>
        {view === 'accounts' ? (
          <AccountBoard
            rows={rows}
            drains={drains}
            anchor={anchor}
            now={now}
            advanced={advanced}
            density={density}
            onDensity={setDensity}
            onChanged={() => {
              drains.refresh();
              workspace.refresh();
            }}
          />
        ) : view === 'analysis' ? (
          <CapacityAnalysis rows={rows} anchor={anchor} now={now} onSelect={select} />
        ) : (
          <CapacityModelSupport accounts={accounts} onSelect={select} />
        )}
      </div>
    </div>
  );
}
