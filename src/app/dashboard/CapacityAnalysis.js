'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Group,
  Loader,
  Pagination,
  Progress,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { Icon } from '@/shared/components/Icon';
import { QuotaSummary } from '@/shared/workspace/QuotaEvidence';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { chartThemeColors } from '@/shared/workspace/metricColors';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import shared from '@/shared/workspace/workspace.module.css';
import { BUCKETS, accountBucket, accountStateWord } from './accountBoardModel';
import styles from './capacityViews.module.css';

const FEATURES = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const number = (value) => (value == null ? '—' : new Intl.NumberFormat('en-US').format(value));
const compact = (value) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
        value
      );
const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const validDate = (value) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0;
const timestamp = (value) =>
  validDate(value)
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : 'Unknown';

// Recorded input split into uncached, cached-read and cache-write shares.
function TokenMeasure({ record, state }) {
  if (state) return <span className={styles.unknown}>{state}</span>;
  if (!record) return <span className={styles.unknown}>No recorded attempts</span>;
  const total = record.inputSamples === 0 ? null : record.inputTokens;
  const completeBreakdown =
    total > 0 &&
    record.inconsistentCacheRows === 0 &&
    record.inputSamples === record.records &&
    record.cacheReadSamples === record.records &&
    record.cacheWriteSamples === record.records &&
    record.uncachedInputSamples === record.records;
  const read = total > 0 ? (record.cacheReadTokens / total) * 100 : 0;
  const write = total > 0 ? (record.cacheWriteTokens / total) * 100 : 0;
  return (
    <Tooltip
      label={`${number(total)} recorded input tokens across ${number(record.inputSamples)} of ${number(record.records)} attempts. Cached reads ${number(record.cacheReadTokens)} (${number(record.cacheReadSamples)} samples); cache writes ${number(record.cacheWriteTokens)} (${number(record.cacheWriteSamples)} samples).`}
    >
      <div className={styles.tokenMeasure}>
        <span>
          {compact(total)} input
          <small>{pct(record.cacheReadFraction)} read</small>
        </span>
        {completeBreakdown ? (
          <Progress.Root size={4} radius={0}>
            <Progress.Section
              aria-label="Uncached share of recorded input"
              value={Math.max(0, 100 - read - write)}
              color="var(--metric-input)"
            />
            <Progress.Section
              aria-label="Cached read share of recorded input"
              value={read}
              color="var(--metric-cache)"
            />
            <Progress.Section
              aria-label="Cache write share of recorded input"
              value={write}
              color="var(--metric-write)"
            />
          </Progress.Root>
        ) : (
          <span className={styles.unknownScale} />
        )}
      </div>
    </Tooltip>
  );
}

// Stored reset deadlines over the next seven days, one diamond each.
function ResetOverview({ windows, anchor, onSelect }) {
  const { colorScheme } = useMantineColorScheme();
  const future = windows.filter(
    (window) =>
      validDate(window.resetAt) &&
      Date.parse(window.resetAt) > anchor &&
      Date.parse(window.resetAt) <= anchor + 7 * 86400000
  );
  const option = useMemo(() => {
    const theme = chartThemeColors(colorScheme);
    return {
      grid: { left: 12, right: 14, top: 12, bottom: 23 },
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        confine: true,
        formatter: (item) =>
          `${item.data.account}\n${item.data.scope}\n${timestamp(item.value[0])} UTC`,
      },
      xAxis: {
        type: 'time',
        min: anchor,
        max: anchor + 7 * 86400000,
        axisLabel: {
          color: theme.slate,
          fontSize: 12,
          hideOverlap: true,
          formatter: (value) =>
            new Date(value).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }),
        },
        axisLine: { lineStyle: { color: theme.rule } },
        splitLine: { show: true, lineStyle: { color: theme.rule } },
        axisTick: { show: false },
      },
      yAxis: { type: 'value', min: 0, max: 2, show: false },
      series: [
        {
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 9,
          itemStyle: { color: METRIC_COLORS.input, opacity: 0.8 },
          data: future.map((window, index) => ({
            value: [Date.parse(window.resetAt), 0.7 + (index % 3) * 0.3],
            connectionId: window.connectionId,
            account: window.account,
            scope: window.scope,
          })),
        },
      ],
    };
  }, [anchor, future, colorScheme]);
  return (
    <div className={styles.resetOverview}>
      <div>
        <h3>Reset horizon</h3>
        <p>{future.length} stored deadlines in the next 7 days</p>
      </div>
      <div className={styles.resetChart}>
        <AnalyticalChart
          option={option}
          height={46}
          label={`${future.length} recorded quota reset deadlines in the next seven days. Select an account row for the equivalent exact deadline.`}
          onEvents={{
            click: (event) => {
              if (event.data?.connectionId) onSelect(event.data.connectionId, event.data.scope);
            },
          }}
        />
      </div>
      <Select
        size="xs"
        aria-label="Inspect a reset deadline"
        placeholder="Inspect deadline"
        searchable
        clearable
        value={null}
        onChange={(value) => {
          const chosen = future.find(
            (window) => `${window.connectionId}:${window.scope}` === value
          );
          if (chosen) onSelect(chosen.connectionId, chosen.scope);
        }}
        data={future.map((window) => ({
          value: `${window.connectionId}:${window.scope}`,
          label: `${timestamp(window.resetAt)} · ${window.account} · ${window.scope}`,
        }))}
        comboboxProps={{ width: 480 }}
      />
    </div>
  );
}

// The historical account table: recorded activity, cache shares and every
// retained quota window, sortable, over the shared interval.
export function CapacityAnalysis({ rows, anchor, now, onSelect }) {
  const workspace = useWorkspace();
  const { scope } = workspace;
  const activity = workspace.inventoryActivity || workspace.activity;
  const activityPagination =
    activity.data?.groupPagination || workspace.activity.data?.groupPagination;
  const [query, setQuery] = useState('');
  const [bucketFilter, setBucketFilter] = useState(null);
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!scope.provider || row.provider === scope.provider) &&
          (!scope.connectionId || row.connectionId === scope.connectionId) &&
          (!bucketFilter || accountBucket(row, now) === bucketFilter) &&
          `${row.displayName} ${row.provider}`.toLowerCase().includes(query.toLowerCase())
      ),
    [rows, scope.provider, scope.connectionId, bucketFilter, query, now]
  );
  const allWindows = useMemo(
    () =>
      filteredRows.flatMap((row) =>
        row.windows.map((window) => ({
          ...window,
          connectionId: row.connectionId,
          account: row.displayName,
        }))
      ),
    [filteredRows]
  );
  const historicalOnly = (activity.data?.groups || []).filter(
    (group) => !rows.some((row) => row.connectionId === group.connectionId)
  );
  const columns = useMemo(
    () => [
      {
        accessorKey: 'displayName',
        header: 'Account',
        cell: ({ row }) => (
          <UnstyledButton
            className={styles.accountCell}
            onClick={() => onSelect(row.original.connectionId)}
          >
            <ProviderMark provider={row.original.provider} size="small" />
            <span>
              <strong>{row.original.displayName || row.original.provider}</strong>
              <small>{providerIdentity(row.original.provider).name}</small>
            </span>
          </UnstyledButton>
        ),
      },
      {
        accessorKey: 'status',
        header: 'State and local gates',
        cell: ({ row }) => {
          const bucket = accountBucket(row.original, now);
          return (
            <Tooltip
              label={`Derived from stored test status, errors, cooldown and local controls. Not model support or quota availability. Pending counters can expire or lag. Credential-check timestamp ${timestamp(row.original.lastQualifiedAt)} UTC.`}
            >
              <div className={styles.gateCell}>
                <span className={styles.state} data-tone={TONE[bucket]}>
                  <i />
                  {accountStateWord(row.original, now)}
                </span>
                <small>
                  {row.original.drain
                    ? `${number(row.original.drain.activeStreams)} observed pending · this process`
                    : 'Pending count unknown'}
                </small>
              </div>
            </Tooltip>
          );
        },
      },
      {
        accessorKey: 'records',
        header: 'Recorded activity',
        cell: ({ row }) => (
          <div className={styles.accountActivity}>
            <span>
              {row.original.activityState ||
                (row.original.records >= 0
                  ? `${number(row.original.records)} attempts`
                  : 'No recorded attempts')}
            </span>
            <TokenMeasure
              record={row.original.activity}
              state={row.original.activityState ? 'Input unavailable' : null}
            />
          </div>
        ),
      },
      {
        id: 'quota',
        header: (
          <Tooltip label="Each retained percentage has its own scope. Longer explicitly reported durations appear first, followed by unknown durations. This display order is not an eligibility verdict.">
            <span>Remaining by window ⓘ</span>
          </Tooltip>
        ),
        enableSorting: false,
        cell: ({ row }) => (
          <QuotaSummary
            windows={row.original.windows}
            onInspect={(windowScope) => onSelect(row.original.connectionId, windowScope)}
          />
        ),
      },
    ],
    [onSelect, now]
  );
  const table = useTable({
    features: FEATURES,
    columns,
    data: filteredRows,
    getRowId: (row) => row.connectionId,
    initialState: { sorting: [{ id: 'records', desc: true }] },
  });
  return (
    <div className={styles.book}>
      <div className={styles.bookToolbar}>
        <div className={styles.bookTitle}>
          <h2>Configured accounts</h2>
          <Badge variant="light" color="gray" size="sm">
            {filteredRows.length}
          </Badge>
          <span>{allWindows.length} quota windows · shared interval</span>
        </div>
        <Group gap={6}>
          <TextInput
            size="xs"
            aria-label="Search configured accounts"
            placeholder="Find an account"
            leftSection={<Icon name="i-search" />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className={styles.accountSearch}
          />
          <Select
            size="xs"
            aria-label="State filter"
            placeholder="Any state"
            clearable
            value={bucketFilter}
            onChange={setBucketFilter}
            data={BUCKETS.map((bucket) => ({ value: bucket.id, label: bucket.label }))}
            w={130}
          />
        </Group>
      </div>
      {activityPagination?.totalPages > 1 && (
        <div className={styles.activityPages}>
          <Text size="xs">
            Activity groups {number(activityPagination.totalItems)} · page{' '}
            {workspace.activityGroupPage} of {number(activityPagination.totalPages)}. Totals above
            cover the complete scope; accounts absent from this page stay unknown.
          </Text>
          <Pagination
            size="xs"
            total={activityPagination.totalPages}
            value={workspace.activityGroupPage}
            onChange={workspace.setActivityGroupPage}
            disabled={activity.loading}
            aria-label="Inventory activity pages"
          />
        </div>
      )}
      {anchor > 0 && allWindows.length > 0 && (
        <ResetOverview windows={allWindows} anchor={anchor} onSelect={onSelect} />
      )}
      <div className={styles.tableRegion}>
        {workspace.health.loading ? (
          <div className={shared.emptyMessage}>
            <Loader size="xs" /> Loading account observations…
          </div>
        ) : (
          <Table.ScrollContainer
            minWidth={760}
            type="native"
            className={styles.tableScroll}
            tabIndex={0}
            role="region"
            aria-label="Configured account capacity table scroll"
          >
            <Table
              stickyHeader
              highlightOnHover
              className={styles.accountTable}
              aria-label="Configured account capacity"
            >
              <Table.Thead>
                {table.getHeaderGroups().map((group) => (
                  <Table.Tr key={group.id}>
                    {group.headers.map((header) => (
                      <Table.Th
                        key={header.id}
                        aria-sort={
                          header.column.getIsSorted() === 'asc'
                            ? 'ascending'
                            : header.column.getIsSorted() === 'desc'
                              ? 'descending'
                              : undefined
                        }
                      >
                        {header.column.getCanSort() ? (
                          <UnstyledButton
                            className={styles.sortButton}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            <table.FlexRender header={header} />
                            <span>
                              {header.column.getIsSorted() === 'desc'
                                ? '↓'
                                : header.column.getIsSorted() === 'asc'
                                  ? '↑'
                                  : ''}
                            </span>
                          </UnstyledButton>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Thead>
              <Table.Tbody>
                {table.getRowModel().rows.map((row) => (
                  <Table.Tr key={row.original.connectionId}>
                    {row.getAllCells().map((cell) => (
                      <Table.Td key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {filteredRows.length === 0 && (
              <div className={shared.emptyMessage}>No configured accounts match these filters.</div>
            )}
          </Table.ScrollContainer>
        )}
      </div>
      <div className={styles.bookFoot}>
        <span>
          {historicalOnly.length
            ? `${historicalOnly.length} historical account IDs are absent from current configuration.`
            : 'Current configured accounts · historical activity in the shared interval.'}{' '}
          <Link href="/dashboard/usage">Open Economics</Link>
        </span>
        <span>
          <i style={{ background: 'var(--metric-input)' }} />
          Uncached input <i style={{ background: 'var(--metric-cache)' }} />
          Cached read <i style={{ background: 'var(--metric-write)' }} />
          Cache write
        </span>
      </div>
    </div>
  );
}
