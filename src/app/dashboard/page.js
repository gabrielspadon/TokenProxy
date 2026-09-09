'use client';
import { useMemo } from 'react';
import { useLocalStorage } from '@mantine/hooks';
import { orderQuotaWindows } from '@/shared/workspace/QuotaEvidence';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './capacity.module.css';
import { AccountBoard } from './AccountBoard';
import { CapacityActivity } from './CapacityActivity';
import { DRAIN_ENDPOINT } from './capacityControlsModel';

const EMPTY = [];

export default function CapacityPage() {
  const workspace = useWorkspace();
  const { accounts, quota, snapshot } = workspace;
  const drains = useResource(DRAIN_ENDPOINT, { onSnapshot: workspace.observeSnapshot });
  // The sidebar switch owns the level. Everyday hides priority, drain, thresholds
  // and comparison; Advanced puts them beside each account.
  const [navigationMode] = useLocalStorage({
    key: 'tokenproxy.navigation-mode',
    defaultValue: 'everyday',
  });
  const advanced = navigationMode === 'advanced';
  const activity = workspace.inventoryActivity || workspace.activity;
  const anchor = snapshot?.capturedAt
    ? Date.parse(snapshot.capturedAt)
    : quota.data?.asOf
      ? Date.parse(quota.data.asOf)
      : 0;
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
  return (
    <div className={styles.page}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Capacity</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · every account, its quota and its controls</p>
        </div>
      </div>
      <ScopeBar />
      <CapacityActivity />
      <div className={styles.boardWrap}>
        <AccountBoard
          rows={rows}
          drains={drains}
          anchor={snapshot?.isolated ? anchor : undefined}
          advanced={advanced}
          onChanged={() => {
            drains.refresh();
            workspace.refresh();
          }}
        />
      </div>
    </div>
  );
}
