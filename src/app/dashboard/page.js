'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { Icon } from '@/shared/components/Icon';
import { ActivityBand } from '@/shared/workspace/ActivityBand';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { useWorkspace, analyticsUrl } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './capacity.module.css';

const FEATURES = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
const EMPTY = [];
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
function primaryWindow(windows, anchor) {
  return [...windows].sort((a, b) => {
    const first =
      validDate(a.resetAt) && Date.parse(a.resetAt) >= anchor ? Date.parse(a.resetAt) : Infinity;
    const second =
      validDate(b.resetAt) && Date.parse(b.resetAt) >= anchor ? Date.parse(b.resetAt) : Infinity;
    return first - second || (a.scope || '').localeCompare(b.scope || '');
  })[0];
}
function quotaPercentage(window) {
  const value = window?.percentage?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}
function State({ value }) {
  const state = {
    healthy: ['teal', 'Healthy'],
    degraded: ['orange', 'Degraded'],
    cooldown: ['orange', 'Cooldown'],
    drained: ['gray', 'Draining'],
    unqualified: ['gray', 'Unqualified'],
  }[value] || ['gray', 'Unknown'];
  return (
    <span className={styles.state} data-color={state[0]}>
      <i />
      {state[1]}
    </span>
  );
}
function WindowEvidence({ window, count = 1 }) {
  if (!window) return <span className={styles.unknown}>Not recorded</span>;
  const percentage = quotaPercentage(window);
  return (
    <Tooltip
      label={`${window.scope || 'Unspecified scope'}. ${percentage == null ? 'No comparable unit or retained percentage is recorded.' : 'Percentage retained in connection.lastQuotaSnapshot, independent of the quota-window quantity.'} ${count > 1 ? `${count} windows. Select the account to inspect each.` : ''}`}
    >
      <div className={styles.windowEvidence}>
        <span>
          {percentage == null ? 'Unknown headroom' : `${number(percentage)}% remaining`}
          {count > 1 && <span className={styles.moreWindows}>+{count - 1}</span>}
        </span>
        {percentage == null ? (
          <span className={styles.unknownScale} />
        ) : (
          <Progress
            value={percentage}
            color={window.percentage.freshness?.state === 'fresh' ? 'indigo' : 'gray'}
            size={4}
            radius={0}
          />
        )}
      </div>
    </Tooltip>
  );
}
function ResetDeadline({ window, anchor }) {
  if (!validDate(window?.resetAt)) return <span className={styles.unknown}>Not recorded</span>;
  const passed = Date.parse(window.resetAt) <= anchor;
  return (
    <Tooltip
      label={
        passed
          ? 'Stored deadline passed. A new observation is needed; this does not establish recovered quota.'
          : 'Stored reset deadline. No new upstream observation is made.'
      }
    >
      <div className={styles.reset}>
        <span>{timestamp(window.resetAt)}</span>
        {passed && <span data-passed="true">· passed</span>}
      </div>
    </Tooltip>
  );
}
function TokenMeasure({ record }) {
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
      label={`${number(total)} recorded input tokens across ${number(record.inputSamples)} of ${number(record.records)} attempts. Cached reads ${number(record.cacheReadTokens)} (${number(record.cacheReadSamples)} samples); cache writes ${number(record.cacheWriteTokens)} (${number(record.cacheWriteSamples)} samples). Historical provenance was not retained.`}
    >
      <div className={styles.tokenMeasure}>
        <span>
          {compact(total)}
          <small>{pct(record.cacheReadFraction)} read</small>
        </span>
        {completeBreakdown ? (
          <Progress.Root size={4} radius={0}>
            <Progress.Section value={Math.max(0, 100 - read - write)} color={METRIC_COLORS.input} />
            <Progress.Section value={read} color={METRIC_COLORS.cacheRead} />
            <Progress.Section value={write} color={METRIC_COLORS.cacheWrite} />
          </Progress.Root>
        ) : (
          <span className={styles.unknownScale} />
        )}
      </div>
    </Tooltip>
  );
}
function ResetOverview({ windows, anchor, onSelect }) {
  const future = windows.filter(
    (window) =>
      validDate(window.resetAt) &&
      Date.parse(window.resetAt) > anchor &&
      Date.parse(window.resetAt) <= anchor + 7 * 86400000
  );
  const option = useMemo(
    () => ({
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
          color: '#5e6d85',
          fontSize: 13,
          formatter: (value) =>
            new Date(value).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }),
        },
        axisLine: { lineStyle: { color: '#dbe2ed' } },
        splitLine: { show: true, lineStyle: { color: '#eef1f7' } },
        axisTick: { show: false },
      },
      yAxis: { type: 'value', min: 0, max: 2, show: false },
      series: [
        {
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 9,
          itemStyle: { color: '#6479c5', opacity: 0.8 },
          data: future.map((window, index) => ({
            value: [Date.parse(window.resetAt), 0.7 + (index % 3) * 0.3],
            connectionId: window.connectionId,
            account: window.account,
            scope: window.scope,
          })),
        },
      ],
    }),
    [anchor, future]
  );
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
function QuotaTable({ windows, anchor, selectedScope }) {
  return (
    <Table className={styles.quotaTable} striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Reported scope</Table.Th>
          <Table.Th>Remaining evidence</Table.Th>
          <Table.Th>Reset deadline (UTC)</Table.Th>
          <Table.Th>Observation (UTC)</Table.Th>
          <Table.Th>Basis</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {windows.map((window) => (
          <Table.Tr key={window.scope} bg={window.scope === selectedScope ? 'indigo.0' : undefined}>
            <Table.Td>{window.scope || 'Unspecified'}</Table.Td>
            <Table.Td>
              <WindowEvidence window={window} />
            </Table.Td>
            <Table.Td>
              <ResetDeadline window={window} anchor={anchor} />
            </Table.Td>
            <Table.Td>{timestamp(window.observedAt)}</Table.Td>
            <Table.Td>
              {window.percentage
                ? `Retained percentage · ${window.percentage.freshness?.state || 'unknown age'}`
                : window.scale === 'absolute'
                  ? 'Absolute quantity · unit unknown'
                  : 'Unit and measurement unknown'}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
function AccountDetail({ row, anchor, onScope, selectedScope }) {
  const { scope, observeSnapshot } = useWorkspace();
  const [tab, setTab] = useState(selectedScope ? 'quota' : 'summary');
  const requests = useResource(
    tab === 'requests'
      ? analyticsUrl({ ...scope, connectionId: row.connectionId }, 'activity', { pageSize: '20' })
      : null,
    { onSnapshot: observeSnapshot }
  );
  const record = row.activity;
  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <Tabs.List px={20}>
        <Tabs.Tab value="summary">Account details</Tabs.Tab>
        <Tabs.Tab value="quota">Quota windows ({row.windows.length})</Tabs.Tab>
        <Tabs.Tab value="requests">Recent attempts</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="summary">
        <div className={shared.dockBody}>
          <div className={shared.dockGrid}>
            <div className={shared.detailSection}>
              <h3>Persisted routing state</h3>
              <dl className={shared.facts}>
                <dt>Provider</dt>
                <dd>{providerIdentity(row.provider).name}</dd>
                <dt>Account enabled</dt>
                <dd>{row.isActive ? 'Enabled' : 'Disabled'}</dd>
                <dt>Recorded status</dt>
                <dd>
                  <State value={row.status} />
                </dd>
                <dt>Draining</dt>
                <dd>{row.isDraining ? 'Yes' : 'No'}</dd>
                <dt>Last qualification</dt>
                <dd>{timestamp(row.lastQualifiedAt)}</dd>
              </dl>
              <Button mt="md" component={Link} href="/dashboard/connections" variant="light">
                Manage connection
              </Button>
            </div>
            <div className={shared.detailSection}>
              <h3>Recorded activity in the selected interval</h3>
              <dl className={shared.facts}>
                <dt>Attempts</dt>
                <dd>{number(record?.records)}</dd>
                <dt>Failed</dt>
                <dd>{number(record?.failed)}</dd>
                <dt>Input tokens, cache-inclusive</dt>
                <dd>{number(record?.inputTokens)}</dd>
                <dt>Cached reads</dt>
                <dd>{number(record?.cacheReadTokens)}</dd>
                <dt>Cache writes</dt>
                <dd>{number(record?.cacheWriteTokens)}</dd>
                <dt>Output tokens</dt>
                <dd>{number(record?.outputTokens)}</dd>
              </dl>
            </div>
            <div className={shared.detailSection}>
              <h3>Evidence and scope</h3>
              <Text size="sm" c="dimmed">
                Recorded health and quota are observations, not a guarantee of upstream
                availability. Historical token provenance was not retained.
              </Text>
              {row.lastError && (
                <Text mt="sm" size="sm" c="orange.8">
                  {row.lastError}
                </Text>
              )}
              <Button mt="md" variant="subtle" onClick={() => onScope(row.connectionId)}>
                Use this account as shared scope <Icon name="i-right" />
              </Button>
            </div>
          </div>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="quota">
        <div className={shared.dockBody}>
          {row.windows.length ? (
            <ScrollArea>
              <QuotaTable windows={row.windows} anchor={anchor} selectedScope={selectedScope} />
            </ScrollArea>
          ) : (
            <Text size="sm" c="dimmed">
              No quota windows were recorded for this account.
            </Text>
          )}
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="requests">
        <div className={shared.dockBody}>
          {requests.loading ? (
            <Loader size="sm" />
          ) : requests.error ? (
            <Text c="red">{requests.error}</Text>
          ) : (
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>UTC</Table.Th>
                  <Table.Th>Model</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Input</Table.Th>
                  <Table.Th>Cached read</Table.Th>
                  <Table.Th>Output</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(requests.data?.items || []).map((item) => (
                  <Table.Tr key={item.id}>
                    <Table.Td>{timestamp(item.timestamp)}</Table.Td>
                    <Table.Td>{item.model}</Table.Td>
                    <Table.Td>{item.status}</Table.Td>
                    <Table.Td>{number(item.inputTokens)}</Table.Td>
                    <Table.Td>{number(item.cacheReadTokens)}</Table.Td>
                    <Table.Td>{number(item.outputTokens)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </div>
      </Tabs.Panel>
    </Tabs>
  );
}
function CompareAccounts({ rows }) {
  return (
    <div className={shared.dockBody}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Account</Table.Th>
            <Table.Th>Recorded status</Table.Th>
            <Table.Th>Attempts</Table.Th>
            <Table.Th>Input tokens</Table.Th>
            <Table.Th>Cached reads</Table.Th>
            <Table.Th>Cache read share</Table.Th>
            <Table.Th>Quota windows</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.connectionId}>
              <Table.Td>{row.displayName}</Table.Td>
              <Table.Td>
                <State value={row.status} />
              </Table.Td>
              <Table.Td>{number(row.activity?.records)}</Table.Td>
              <Table.Td>{number(row.activity?.inputTokens)}</Table.Td>
              <Table.Td>{number(row.activity?.cacheReadTokens)}</Table.Td>
              <Table.Td>{pct(row.activity?.cacheReadFraction)}</Table.Td>
              <Table.Td>{row.windows.length}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text mt="md" size="sm" c="dimmed">
        The same historical interval applies to every selected account. Quota measurements are
        separate observations; windows with unknown units cannot be summed.
      </Text>
    </div>
  );
}
function ModelSupport({ accounts, onSelect }) {
  const { scope, models, observeSnapshot } = useWorkspace();
  const [model, setModel] = useState(scope.model);
  const choices = (models.data?.models || EMPTY).filter(
    (item) => !scope.provider || item.provider === scope.provider
  );
  const modelOptions = [...new Set(choices.map((item) => item.model))];
  const provider = scope.provider || choices.find((item) => item.model === model)?.provider;
  const query = new URLSearchParams({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  const eligibility = useResource(model ? `/api/admin/eligibility?${query}` : null, {
    onSnapshot: observeSnapshot,
  });
  return (
    <div className={styles.support}>
      <Group justify="space-between" mb="md">
        <div>
          <h2>Account and model evidence</h2>
          <Text size="sm" c="dimmed">
            Persisted local admission and explicit model support, without an upstream probe.
          </Text>
        </div>
        <Select
          aria-label="Model to inspect"
          placeholder="Choose a model"
          searchable
          data={modelOptions}
          value={model}
          onChange={setModel}
          w={300}
        />
      </Group>
      {!model ? (
        <div className={shared.emptyMessage}>
          Choose a model to compare local evidence across all accounts.
        </div>
      ) : eligibility.loading ? (
        <Loader size="sm" />
      ) : eligibility.error ? (
        <Text c="red">Model evidence is unavailable. {eligibility.error}</Text>
      ) : (
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Account</Table.Th>
              <Table.Th>Local admission</Table.Th>
              <Table.Th>Model support</Table.Th>
              <Table.Th>Evidence</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(eligibility.data?.accounts || []).map((account) => (
              <Table.Tr key={account.connectionId}>
                <Table.Td>
                  <UnstyledButton onClick={() => onSelect(account.connectionId)}>
                    {accounts.find((item) => item.connectionId === account.connectionId)
                      ?.displayName || account.connectionId}
                  </UnstyledButton>
                </Table.Td>
                <Table.Td>
                  <Badge
                    variant="light"
                    color={
                      account.verdict === 'admissible'
                        ? 'teal'
                        : account.verdict === 'blocked'
                          ? 'orange'
                          : 'gray'
                    }
                  >
                    {account.verdict}
                  </Badge>
                </Table.Td>
                <Table.Td>{account.modelSupport?.status || 'Unknown'}</Table.Td>
                <Table.Td>
                  {account.reasons?.map((reason) => reason.label).join(' · ') ||
                    'No model-specific support evidence'}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}
export default function CapacityPage() {
  const workspace = useWorkspace();
  const {
    accounts,
    quota,
    activity,
    snapshot,
    scope,
    setScope,
    selectedAccountId,
    setSelectedAccountId,
    comparisonIds,
    setComparisonIds,
  } = workspace;
  const [view, setView] = useState('accounts'),
    [query, setQuery] = useState(''),
    [stateFilter, setStateFilter] = useState(null),
    [comparing, setComparing] = useState(false);
  const [selectedScope, setSelectedScope] = useState(null);
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
          windows,
          primary: primaryWindow(windows, anchor),
          activity: record,
          records: record?.records ?? -1,
          inputTokens: record?.inputTokens ?? -1,
        };
      }),
    [accounts, quota.data, activity.data, anchor]
  );
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!scope.provider || row.provider === scope.provider) &&
          (!scope.connectionId || row.connectionId === scope.connectionId) &&
          (!stateFilter || row.status === stateFilter) &&
          `${row.displayName} ${row.provider}`.toLowerCase().includes(query.toLowerCase())
      ),
    [rows, scope.provider, scope.connectionId, stateFilter, query]
  );
  const selected = rows.find((row) => row.connectionId === selectedAccountId);
  const compareRows = rows.filter((row) => comparisonIds.includes(row.connectionId));
  const maxRequests = Math.max(1, ...rows.map((row) => row.records));
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
    (group) => !accounts.some((account) => account.connectionId === group.connectionId)
  );
  const select = (id, windowScope = null) => {
    setSelectedScope(windowScope);
    setSelectedAccountId(id);
    setComparing(false);
  };
  const columns = useMemo(
    () => [
      {
        id: 'compare',
        header: '',
        size: 36,
        enableSorting: false,
        cell: ({ row }) => (
          <Checkbox
            size="xs"
            aria-label={`Compare ${row.original.displayName} (${row.original.provider})`}
            checked={comparisonIds.includes(row.original.connectionId)}
            disabled={
              comparisonIds.length >= 4 && !comparisonIds.includes(row.original.connectionId)
            }
            onChange={(event) =>
              setComparisonIds(
                event.currentTarget.checked
                  ? [...comparisonIds, row.original.connectionId]
                  : comparisonIds.filter((id) => id !== row.original.connectionId)
              )
            }
          />
        ),
      },
      {
        accessorKey: 'displayName',
        header: 'Account',
        cell: ({ row }) => (
          <Tooltip
            label={`${providerIdentity(row.original.provider).name} · ${row.original.displayName}`}
          >
            <UnstyledButton
              className={styles.accountCell}
              onClick={() => {
                setSelectedAccountId(row.original.connectionId);
                setComparing(false);
              }}
            >
              <ProviderMark provider={row.original.provider} size="small" />
              <span>{row.original.displayName || row.original.provider}</span>
            </UnstyledButton>
          </Tooltip>
        ),
      },
      {
        accessorKey: 'status',
        header: snapshot ? 'Recorded state' : 'Routing state',
        cell: ({ row }) => <State value={row.original.status} />,
      },
      {
        accessorKey: 'records',
        header: 'Attempts',
        cell: ({ row }) => (
          <div className={styles.requestMeasure}>
            <span>{row.original.records >= 0 ? number(row.original.records) : '—'}</span>
            <Progress
              value={(Math.max(0, row.original.records) / maxRequests) * 100}
              color="#a5b3df"
              size={3}
              radius={0}
            />
          </div>
        ),
      },
      {
        accessorKey: 'inputTokens',
        header: 'Recorded input',
        cell: ({ row }) => <TokenMeasure record={row.original.activity} />,
      },
      {
        id: 'quota',
        header: 'Remaining evidence',
        enableSorting: false,
        cell: ({ row }) => (
          <WindowEvidence window={row.original.primary} count={row.original.windows.length} />
        ),
      },
      {
        id: 'reset',
        accessorFn: (row) =>
          validDate(row.primary?.resetAt) ? Date.parse(row.primary.resetAt) : Infinity,
        header: 'Reset deadline · UTC',
        cell: ({ row }) => <ResetDeadline window={row.original.primary} anchor={anchor} />,
      },
    ],
    [comparisonIds, setComparisonIds, setSelectedAccountId, maxRequests, snapshot, anchor]
  );
  const table = useTable({
    features: FEATURES,
    columns,
    data: filteredRows,
    initialState: { sorting: [{ id: 'records', desc: true }] },
  });
  return (
    <>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Capacity book</h1>
          <p>Account allocation, quota evidence and reset horizons</p>
        </div>
        <SegmentedControl
          aria-label="Capacity view"
          value={view}
          onChange={setView}
          size="xs"
          data={[
            { value: 'accounts', label: 'Accounts' },
            { value: 'support', label: 'Model support' },
          ]}
        />
      </div>
      <ScopeBar />
      <ActivityBand />
      <div className={styles.book}>
        <SelectionDock
          open={Boolean(selected) || comparing}
          title={comparing ? `Compare ${compareRows.length} accounts` : selected?.displayName}
          subtitle={
            comparing
              ? 'Same selected interval · recorded quantities'
              : selected
                ? providerIdentity(selected.provider).name
                : null
          }
          mark={selected && !comparing ? <ProviderMark provider={selected.provider} /> : null}
          onClose={() => {
            setSelectedAccountId(null);
            setComparing(false);
          }}
          detail={
            comparing ? (
              <CompareAccounts rows={compareRows} />
            ) : selected ? (
              <AccountDetail
                key={`${selected.connectionId}:${selectedScope || 'summary'}`}
                row={selected}
                anchor={anchor}
                selectedScope={selectedScope}
                onScope={(connectionId) => setScope({ connectionId })}
              />
            ) : null
          }
          height="calc(100dvh - 270px)"
        >
          <div className={styles.bookBody}>
            <div className={styles.bookToolbar}>
              <div className={styles.bookTitle}>
                <h2>{view === 'accounts' ? 'Configured accounts' : 'Local model support'}</h2>
                <Badge variant="light" color="gray" size="sm">
                  {filteredRows.length}
                </Badge>
                <span>{allWindows.length} quota windows</span>
              </div>
              <Group gap={8}>
                <TextInput
                  aria-label="Search configured accounts"
                  placeholder="Find an account"
                  leftSection={<Icon name="i-search" />}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  className={styles.accountSearch}
                />
                <Select
                  aria-label="Recorded status filter"
                  placeholder="Any state"
                  clearable
                  value={stateFilter}
                  onChange={setStateFilter}
                  data={['healthy', 'degraded', 'cooldown', 'drained', 'unqualified'].map(
                    (value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })
                  )}
                  w={135}
                />
                <Button
                  variant={comparisonIds.length > 1 ? 'light' : 'default'}
                  disabled={comparisonIds.length < 2}
                  onClick={() => {
                    setComparing(true);
                    setSelectedAccountId(null);
                  }}
                >
                  Compare{comparisonIds.length ? ` (${comparisonIds.length})` : ''}
                </Button>
              </Group>
            </div>
            {anchor > 0 && allWindows.length > 0 && view === 'accounts' && (
              <ResetOverview windows={allWindows} anchor={anchor} onSelect={select} />
            )}
            <div className={styles.tableRegion}>
              {workspace.health.loading ? (
                <div className={shared.emptyMessage}>
                  <Loader size="sm" /> Loading account observations…
                </div>
              ) : workspace.health.error ? (
                <div className={shared.emptyMessage}>
                  {workspace.health.error}
                  <Button onClick={workspace.health.refresh}>Try again</Button>
                </div>
              ) : view === 'support' ? (
                <ModelSupport accounts={accounts} onSelect={select} />
              ) : (
                <Table.ScrollContainer minWidth={990} type="native" className={styles.tableScroll}>
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
                        <Table.Tr
                          key={row.original.connectionId}
                          data-selected={
                            selectedAccountId === row.original.connectionId ||
                            comparisonIds.includes(row.original.connectionId) ||
                            undefined
                          }
                        >
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
                    <div className={shared.emptyMessage}>
                      No configured accounts match these filters.
                    </div>
                  )}
                </Table.ScrollContainer>
              )}
            </div>
            <div className={styles.bookFoot}>
              <span>
                {historicalOnly.length
                  ? `${historicalOnly.length} historical account IDs are absent from current configuration.`
                  : 'Only configured accounts appear in this book.'}{' '}
                <Link href="/dashboard/usage">Open ledger</Link>
              </span>
              <span>
                <i style={{ background: METRIC_COLORS.input }} />
                Uncached input <i style={{ background: METRIC_COLORS.cacheRead }} />
                Cached read <i style={{ background: METRIC_COLORS.cacheWrite }} />
                Cache write
              </span>
            </div>
          </div>
        </SelectionDock>
      </div>
    </>
  );
}
