'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Pagination,
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
import { QuotaSummary, WindowEvidence, orderQuotaWindows } from '@/shared/workspace/QuotaEvidence';
import { QuotaHistoryWorkbench } from '@/shared/workspace/QuotaHistoryWorkbench';
import { QuotaAcquisitionControls } from '@/shared/workspace/QuotaAcquisitionControls';
import { ActivityBand } from '@/shared/workspace/ActivityBand';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { chartThemeColors } from '@/shared/workspace/metricColors';
import { useWorkspace, analyticsUrl } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './capacity.module.css';
import { CapacityControls } from './CapacityControls';
import { AccountControlPanel } from './AccountControlPanel';
import { AccountPolicyEvidence } from './AccountPolicyEvidence';
import { DRAIN_ENDPOINT, capacityAttemptSelection, localCapacityState, retainAccountOrder } from './capacityControlsModel';

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
const observedTokens = (record, field, samples) => record?.[samples] > 0 ? record[field] : null;
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
function State({ value }) {
  const state = {
    healthy: ['teal', 'Reported healthy'],
    degraded: ['orange', 'Reported degraded'],
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
function TokenMeasure({ record, state }) {
  if(state) return <span className={styles.unknown}>{state}</span>;
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
function ResetOverview({ windows, anchor, onSelect }) {
  const {colorScheme}=useMantineColorScheme();
  const future = windows.filter(
    (window) =>
      validDate(window.resetAt) &&
      Date.parse(window.resetAt) > anchor &&
      Date.parse(window.resetAt) <= anchor + 7 * 86400000
  );
  const option = useMemo(
    () => {const theme=chartThemeColors(colorScheme);return ({
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
          fontSize: 13,
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
    });},
    [anchor, future, colorScheme]
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
          <Table.Th>Percentage observed (UTC)</Table.Th>
          <Table.Th>Basis</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {orderQuotaWindows(windows).map((window) => (
          <Table.Tr key={window.scope} bg={window.scope === selectedScope ? 'indigo.0' : undefined}>
            <Table.Td>{window.scope || 'Unspecified'}</Table.Td>
            <Table.Td>
              <WindowEvidence window={window} />
            </Table.Td>
            <Table.Td>
              <ResetDeadline window={window} anchor={anchor} />
            </Table.Td>
            <Table.Td>
              <Tooltip
                label={`Quota quantity observed ${timestamp(window.observedAt)} UTC; percentage observation is independent.`}
              >
                <span className={styles.measured}>{timestamp(window.percentage?.observedAt)}</span>
              </Tooltip>
            </Table.Td>
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
function AccountDetail({ row, anchor, onScope, selectedScope, drains, onChanged }) {
  const { scope, observeSnapshot, setSelectedRecord, setContextView } = useWorkspace();
  const router = useRouter();
  const inspectAttempt = (item) => {
    const selection = capacityAttemptSelection(item);
    if (!selection) return;
    setContextView({ sessionId: selection.sessionId, page: 1 });
    setSelectedRecord(selection);
    router.push('/dashboard/context');
  };
  const [tab, setTab] = useState(selectedScope ? 'quota' : 'summary');
  const requests = useResource(
    analyticsUrl({ ...scope, connectionId: row.connectionId }, 'activity', { pageSize: '20' }),
    { onSnapshot: observeSnapshot }
  );
  const record = requests.error ? null : requests.data?.summary;
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
                <dt>Last status timestamp</dt>
                <dd className={styles.measured}>{timestamp(row.lastQualifiedAt)}</dd>
              </dl>
              <Button mt="md" component={Link} href="/dashboard/connections" variant="light">
                Manage connection
              </Button>
            </div>
            <div className={shared.detailSection}>
              <h3>Recorded activity in the selected interval</h3>
              <dl className={shared.facts}>
                <dt>Attempts</dt>
                <dd className={styles.measured}>{number(record?.records)}</dd>
                <dt>Failed</dt>
                <dd className={styles.measured}>{number(record?.failed)}</dd>
                <dt>Input tokens, cache-inclusive</dt>
                <dd className={styles.measured}>{number(observedTokens(record, 'inputTokens', 'inputSamples'))}</dd>
                <dt>Cached reads</dt>
                <dd className={styles.measured}>{number(observedTokens(record, 'cacheReadTokens', 'cacheReadSamples'))}</dd>
                <dt>Cache writes</dt>
                <dd className={styles.measured}>{number(observedTokens(record, 'cacheWriteTokens', 'cacheWriteSamples'))}</dd>
                <dt>Output tokens</dt>
                <dd className={styles.measured}>{number(observedTokens(record, 'outputTokens', 'outputSamples'))}</dd>
              </dl>
            </div>
            <div className={shared.detailSection}>
              <h3>Evidence and scope</h3>
              <Text size="sm" c="dimmed">
                Reported health is derived from persisted test status, errors and local gates. The
                status timestamp is the stored credential-check timestamp when available. It does
                not establish model support or available quota. Historical token provenance was not
                retained.
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
          <AccountPolicyEvidence account={row} />
          <CapacityControls accounts={[row]} drains={drains} onChanged={onChanged} />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="quota">
        <div className={shared.dockBody}>
          {row.windows.length ? (
            <ScrollArea viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Scroll current quota windows' }}>
              <QuotaTable windows={row.windows} anchor={anchor} selectedScope={selectedScope} />
            </ScrollArea>
          ) : (
            <Text size="sm" c="var(--slate)">
              No quota windows were recorded for this account.
            </Text>
          )}
          <QuotaAcquisitionControls key={row.connectionId} account={row} />
          <QuotaHistoryWorkbench account={row} anchor={anchor} selectedScope={selectedScope} />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="requests">
        <div className={shared.dockBody}>
          {requests.loading ? (
            <Loader size="sm" />
          ) : requests.error ? (
            <Text c="red">{requests.error}</Text>
          ) : (
            <ScrollArea viewportProps={{tabIndex:0,role:'region','aria-label':'Recent account attempts'}}><Table striped miw={620}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>UTC</Table.Th>
                  <Table.Th>Evidence</Table.Th>
                  <Table.Th>Requested model</Table.Th>
                  <Table.Th>Recorded model</Table.Th>
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
                    <Table.Td>{capacityAttemptSelection(item) ? <Button size="compact-sm" variant="subtle" onClick={() => inspectAttempt(item)}>Inspect attempt</Button> : <Text size="sm" c="dimmed">No retained link</Text>}</Table.Td>
                    <Table.Td><bdi>{item.requestedModel || 'Unknown'}</bdi></Table.Td>
                    <Table.Td><bdi>{item.model || 'Unknown'}</bdi></Table.Td>
                    <Table.Td>{item.status}</Table.Td>
                    <Table.Td>{number(item.inputTokens)}</Table.Td>
                    <Table.Td>{number(item.cacheReadTokens)}</Table.Td>
                    <Table.Td>{number(item.outputTokens)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table></ScrollArea>
          )}
        </div>
      </Tabs.Panel>
    </Tabs>
  );
}
function ComparisonAccountRow({row}) {
  const {scope,observeSnapshot}=useWorkspace();
  const excluded=(scope.provider && scope.provider!==row.provider) || (scope.connectionId && scope.connectionId!==row.connectionId);
  const resource=useResource(excluded?null:analyticsUrl({...scope,connectionId:row.connectionId},'activity',{pageSize:1}),{onSnapshot:observeSnapshot});
  const record=resource.error?null:resource.data?.summary;
  return <Table.Tr><Table.Td>{row.displayName}</Table.Td><Table.Td><State value={row.status}/></Table.Td>
    <Table.Td>{excluded?'Excluded by scope':resource.loading?'Reading…':resource.error?'Unavailable':number(record?.records)}</Table.Td>
    <Table.Td>{number(observedTokens(record,'inputTokens','inputSamples'))}</Table.Td><Table.Td>{number(observedTokens(record,'cacheReadTokens','cacheReadSamples'))}</Table.Td><Table.Td>{pct(record?.cacheReadFraction)}</Table.Td><Table.Td>{row.windows.length}</Table.Td></Table.Tr>;
}
function CompareAccounts({ rows, drains, onChanged }) {
  return (
    <div className={shared.dockBody}>
      <ScrollArea viewportProps={{tabIndex:0,role:'region','aria-label':'Exact account comparison totals'}}><Table striped miw={740}>
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
          {rows.map(row=><ComparisonAccountRow key={row.connectionId} row={row}/>)}
        </Table.Tbody>
      </Table></ScrollArea>
      <Text mt="md" size="sm" c="dimmed">
        The same historical interval applies to every selected account. Quota measurements are
        separate observations; windows with unknown units cannot be summed.
      </Text>
      <CapacityControls accounts={rows} drains={drains} onChanged={onChanged} />
    </div>
  );
}
function ModelSupport({ accounts, onSelect }) {
  const { scope, models, observeSnapshot } = useWorkspace();
  const [chosenKey, setChosenKey] = useState(null);
  const choices = (models.data?.models || EMPTY).filter(
    (item) => !scope.provider || item.provider === scope.provider
  );
  const pairs = [...new Map(choices.map(item => [JSON.stringify([item.provider, item.model]), item])).entries()];
  const scoped = pairs.filter(([, item]) => item.model === scope.model);
  const chosen = pairs.find(([key]) => key === chosenKey) || (scoped.length === 1 ? scoped[0] : null);
  const model = chosen?.[1].model, provider = chosen?.[1].provider;
  const modelOptions = pairs.map(([value, item]) => ({ value, label: `${providerIdentity(item.provider).name} / ${item.model}` }));
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
          value={chosen?.[0] || null}
          onChange={setChosenKey}
          allowDeselect={false}
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
  const router = useRouter();
  const workspace = useWorkspace();
  const drains = useResource(DRAIN_ENDPOINT, { onSnapshot: workspace.observeSnapshot });
  const refreshAccounts = () => { drains.refresh(); workspace.health.refresh(); };
  const {
    accounts,
    quota,
    snapshot,
    scope,
    setScope,
    selectedAccountId,
    setSelectedAccountId,
    comparisonIds,
    setComparisonIds,
  } = workspace;
  const activity=workspace.inventoryActivity || workspace.activity;
  const activityPagination=activity.data?.groupPagination || workspace.activity.data?.groupPagination;
  const [view, setView] = useState('control'),
    [query, setQuery] = useState(''),
    [stateFilter, setStateFilter] = useState(null),
    [comparing, setComparing] = useState(false);
  const [windowSelection, setSelectedScope] = useState(null);
  const [heldOrder, setHeldOrder] = useState({ key: null, ids: [] });
  const selectedScope=workspace.selectedRecord?.windowScope || windowSelection;
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
          drain: !drains.error ? drains.data?.connections?.find(item => item.connectionId === account.connectionId) : null,
          windows,
          primary: orderQuotaWindows(windows)[0],
          activity: record,
          activityState: activity.loading ? 'Loading activity…' : activity.error ? 'Activity unavailable' : !record && activity.data?.groupPagination?.totalPages>1 ? 'Not on this activity page' : null,
          records: record?.records ?? -1,
          inputTokens: record?.inputTokens ?? -1,
        };
      }),
    [accounts, quota.data, activity.data, activity.loading, activity.error, drains.data, drains.error]
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
    if (!rows.some(row => row.connectionId === id)) {
      router.push(`/dashboard/connections/${encodeURIComponent(id)}`);
      return;
    }
    setSelectedScope(windowScope);
    setSelectedAccountId(id,windowScope);
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
            size="sm"
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
                setSelectedScope(null);
                setSelectedAccountId(row.original.connectionId);
                setComparing(false);
              }}
            >
              <ProviderMark provider={row.original.provider} size="small" />
              <span><strong>{row.original.displayName || row.original.provider}</strong><small>{providerIdentity(row.original.provider).name}</small></span>
            </UnstyledButton>
          </Tooltip>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Health and local gates',
        cell: ({ row }) => (
          <Tooltip
            label={`Derived from stored test status, errors, cooldown and local controls. Not model support or quota availability. Pending counters can expire or lag and do not establish whether a response is still streaming. Credential-check timestamp ${timestamp(row.original.lastQualifiedAt)} UTC.`}
          >
            <div className={styles.gateCell}>
              <State value={row.original.status} />
              <span>{localCapacityState(row.original, row.original.drain)}</span>
              <small>{row.original.drain ? `${number(row.original.drain.activeStreams)} observed pending · this process` : 'Pending count unknown'}</small>
            </div>
          </Tooltip>
        ),
      },
      {
        accessorKey: 'records',
        header: 'Recorded activity',
        cell: ({ row }) => (
          <div className={styles.accountActivity}>
            <span>{row.original.activityState || (row.original.records >= 0 ? `${number(row.original.records)} attempts` : 'No recorded attempts')}</span>
            <TokenMeasure record={row.original.activity} state={row.original.activityState ? 'Input unavailable' : null} />
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
            onInspect={(windowScope) => {
              setSelectedScope(windowScope);
              setSelectedAccountId(row.original.connectionId,windowScope);
              setComparing(false);
            }}
          />
        ),
      },
    ],
    [comparisonIds, setComparisonIds, setSelectedAccountId]
  );
  const table = useTable({
    features: FEATURES,
    columns,
    data: filteredRows,
    getRowId: row => row.connectionId,
    initialState: { sorting: [{ id: 'records', desc: true }] },
  });
  const orderedRows = table.getRowModel().rows;
  const hold = Boolean(selectedAccountId) || comparing;
  const orderKey = hold ? JSON.stringify([query, stateFilter, scope.provider, scope.connectionId, scope.start, scope.end, table.getAllLeafColumns().map(column => [column.id, column.getIsSorted()])]) : null;
  if (heldOrder.key !== orderKey && (!hold || orderedRows.length)) setHeldOrder({ key: orderKey, ids: orderedRows.map(row => row.id) });
  const displayRows = hold && heldOrder.key === orderKey ? retainAccountOrder(orderedRows, heldOrder.ids) : orderedRows;
  return (
    <div className={shared.lensViewport}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Capacity</h1>
          <p>Manage accounts, compare quota and keep work moving.</p>
        </div>
        <SegmentedControl
          className={styles.capacityViews}
          aria-label="Capacity view"
          value={view}
          onChange={setView}
          size="sm"
          data={[
            { value: 'control', label: 'Control panel' },
            { value: 'accounts', label: 'Activity & analysis' },
            { value: 'support', label: 'Model support' },
          ]}
        />
      </div>
      <ScopeBar analysisActions={view !== 'control'} />
      {view === 'accounts' && <ActivityBand />}
      <div className={`${styles.book} ${shared.lensContent}`}>
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
              <CompareAccounts rows={compareRows} drains={drains} onChanged={refreshAccounts} />
            ) : selected ? (
              <AccountDetail
                key={`${selected.connectionId}:${selectedScope || 'summary'}`}
                row={selected}
                anchor={anchor}
                selectedScope={selectedScope}
                drains={drains}
                onChanged={refreshAccounts}
                onScope={(connectionId) => setScope({ connectionId })}
              />
            ) : null
          }
          height="100%"
        >
          {view === 'control' ? <AccountControlPanel
            rows={rows} scope={scope} selectedAccountId={selectedAccountId}
            onSelect={select} onChanged={refreshAccounts} anchor={snapshot?.isolated ? anchor : undefined}
          /> : <div className={styles.bookBody}>
            <div className={styles.bookToolbar}>
              <div className={styles.bookTitle}>
                <h2>{view === 'accounts' ? 'Configured accounts' : 'Local model support'}</h2>
                <Badge variant="light" color="gray" size="sm">
                  {filteredRows.length}
                </Badge>
                <span>{allWindows.length} quota windows · compare up to 4 accounts</span>
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
            {view==='accounts' && activityPagination?.totalPages>1 && <div className={styles.activityPages}>
              <Text size="sm">Activity groups {number(activityPagination.totalItems)} · page {workspace.activityGroupPage} of {number(activityPagination.totalPages)}. Totals above cover the complete scope. Accounts absent from this page stay unknown; selection and comparison read their exact totals.</Text>
              <Pagination size="sm" total={activityPagination.totalPages} value={workspace.activityGroupPage} onChange={workspace.setActivityGroupPage} disabled={activity.loading} aria-label="Inventory activity pages"/>
            </div>}
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
                <><div className={styles.accountCards} aria-label="Configured account capacity cards">
                  {displayRows.map(({original:row})=><article key={row.connectionId} className={styles.accountCard} data-selected={selectedAccountId===row.connectionId || undefined}>
                    <div className={styles.cardHeading}><Checkbox size="sm" aria-label={`Compare ${row.displayName} (${row.provider})`} checked={comparisonIds.includes(row.connectionId)} disabled={comparisonIds.length>=4 && !comparisonIds.includes(row.connectionId)} onChange={event=>setComparisonIds(event.currentTarget.checked?[...comparisonIds,row.connectionId]:comparisonIds.filter(id=>id!==row.connectionId))}/><UnstyledButton className={styles.accountCell} onClick={()=>select(row.connectionId)}><ProviderMark provider={row.provider} size="small"/><span>{row.displayName || row.provider}</span></UnstyledButton></div>
                    <dl className={styles.cardFacts}><div><dt>Reported health</dt><dd><State value={row.status}/></dd></div><div><dt>New selections</dt><dd>{localCapacityState(row,row.drain)}</dd></div><div><dt>Recorded attempts</dt><dd>{row.activityState || (row.records>=0?number(row.records):'No recorded attempts')}</dd></div><div><dt>Recorded input</dt><dd>{number(observedTokens(row.activity,'inputTokens','inputSamples'))} tokens</dd></div><div className={styles.cardQuota}><dt>Remaining quota by window</dt><dd><QuotaSummary windows={row.windows} onInspect={windowScope=>select(row.connectionId,windowScope)}/></dd></div><div className={styles.cardQuota}><dt>First window reset · UTC</dt><dd><ResetDeadline window={row.primary} anchor={anchor}/></dd></div></dl>
                  </article>)}
                  {!filteredRows.length && <div className={shared.emptyMessage}>No configured accounts match these filters.</div>}
                </div><Table.ScrollContainer minWidth={760} type="native" className={styles.tableScroll} tabIndex={0} role="region" aria-label="Configured account capacity table scroll">
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
                      {displayRows.map((row) => (
                        <Table.Tr
                          key={row.original.connectionId}
                          data-selected={
                            selectedAccountId === row.original.connectionId ||
                            undefined
                          }
                          data-compared={
                            comparisonIds.includes(row.original.connectionId) ||
                            undefined
                          }
                          aria-current={selectedAccountId === row.original.connectionId ? 'true' : undefined}
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
                </Table.ScrollContainer></>
              )}
            </div>
            <div className={styles.bookFoot}>
              {hold && <span>Row order is held while inspecting. Choose a sort to order current measurements.</span>}
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
          </div>}
        </SelectionDock>
      </div>
    </div>
  );
}
