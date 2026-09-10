'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Loader, ScrollArea, Table, Tabs, Text, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { providerIdentity } from '@/shared/components/ProviderMark';
import { WindowEvidence, orderQuotaWindows } from '@/shared/workspace/QuotaEvidence';
import { QuotaHistoryWorkbench } from '@/shared/workspace/QuotaHistoryWorkbench';
import { QuotaAcquisitionControls } from '@/shared/workspace/QuotaAcquisitionControls';
import { useWorkspace, analyticsUrl } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import shared from '@/shared/workspace/workspace.module.css';
import styles from '@/shared/workspace/board.module.css';
import { AccountPolicyEvidence } from './AccountPolicyEvidence';
import { capacityAttemptSelection } from './capacityControlsModel';

const EMPTY = [];
const number = (value) => (value == null ? '—' : new Intl.NumberFormat('en-US').format(value));
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
const observedTokens = (record, field, samples) => (record?.[samples] > 0 ? record[field] : null);
const STATUS = {
  healthy: 'Reported healthy',
  degraded: 'Reported degraded',
  cooldown: 'Cooldown',
  drained: 'Draining',
  unqualified: 'Not checked',
};

function ResetDeadline({ window, anchor }) {
  if (!validDate(window?.resetAt)) return <span className={styles.muted}>Not recorded</span>;
  const passed = Date.parse(window.resetAt) <= anchor;
  return (
    <Tooltip
      label={
        passed
          ? 'Stored deadline passed. A new observation is needed; this does not establish recovered quota.'
          : 'Stored reset deadline. No new upstream observation is made.'
      }
    >
      <span>
        {timestamp(window.resetAt)}
        {passed ? <span className={styles.passed}> · passed</span> : null}
      </span>
    </Tooltip>
  );
}

function QuotaTable({ windows, anchor, selectedScope }) {
  return (
    <Table className={styles.evidenceTable} striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Scope</Table.Th>
          <Table.Th>Remaining</Table.Th>
          <Table.Th>Reset (UTC)</Table.Th>
          <Table.Th>Percentage observed</Table.Th>
          <Table.Th>Basis</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {orderQuotaWindows(windows).map((window) => (
          <Table.Tr key={window.scope} data-selected={window.scope === selectedScope || undefined}>
            <Table.Td>{window.scope || 'Unspecified'}</Table.Td>
            <Table.Td>
              <WindowEvidence window={window} />
            </Table.Td>
            <Table.Td>
              <ResetDeadline window={window} anchor={anchor} />
            </Table.Td>
            <Table.Td>
              <Tooltip
                label={`Quota quantity observed ${timestamp(window.observedAt)} UTC; the percentage observation is independent.`}
              >
                <span>{timestamp(window.percentage?.observedAt)}</span>
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

export function AccountDetail({ row, anchor, selectedScope, verdict }) {
  // A deep link expands the row before the quota list has answered.
  const windows = Array.isArray(row.windows) ? row.windows : EMPTY;
  const { scope, setScope, observeSnapshot, setSelectedRecord, setContextView } = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useState(selectedScope ? 'quota' : 'overview');
  const requests = useResource(
    analyticsUrl({ ...scope, connectionId: row.connectionId }, 'activity', { pageSize: '20' }),
    { onSnapshot: observeSnapshot }
  );
  const record = requests.error ? null : requests.data?.summary;
  const inspectAttempt = (item) => {
    const selection = capacityAttemptSelection(item);
    if (!selection) return;
    setContextView({ sessionId: selection.sessionId, page: 1 });
    setSelectedRecord(selection);
    router.push('/dashboard/context');
  };
  return (
    <Tabs
      value={tab}
      onChange={setTab}
      keepMounted={false}
      classNames={{ list: styles.tabList, tab: styles.tab, panel: styles.tabPanel }}
    >
      <Tabs.List>
        <Tabs.Tab value="overview">Overview</Tabs.Tab>
        <Tabs.Tab value="quota">Quota windows ({windows.length})</Tabs.Tab>
        <Tabs.Tab value="requests">Recent attempts</Tabs.Tab>
        <Tabs.Tab value="policy">Policy</Tabs.Tab>
        <Button
          component={Link}
          href={`/dashboard/connections/${encodeURIComponent(row.connectionId)}`}
          size="xs"
          variant="subtle"
          ml="auto"
          rightSection={<Icon name="i-open" />}
        >
          Connections
        </Button>
      </Tabs.List>
      <Tabs.Panel value="overview">
        <div className={styles.facts}>
          <dl className={shared.facts}>
            <dt>Provider</dt>
            <dd>{providerIdentity(row.provider).name}</dd>
            <dt>Account ID</dt>
            <dd>
              <bdi>{row.connectionId}</bdi>
            </dd>
            <dt>Authentication</dt>
            <dd>{row.authType || 'Unknown'}</dd>
            {row.email ? (
              <>
                <dt>Email</dt>
                <dd>{row.email}</dd>
              </>
            ) : null}
            <dt>Enabled</dt>
            <dd>{row.isActive === false ? 'Paused' : 'On'}</dd>
            <dt>Recorded status</dt>
            <dd>{STATUS[row.status] || 'Unknown'}</dd>
            <dt>Draining</dt>
            <dd>{(row.drain?.isDraining ?? row.isDraining) ? 'Yes' : 'No'}</dd>
            <dt>Status recorded</dt>
            <dd>{timestamp(row.lastQualifiedAt)} UTC</dd>
            <dt>Priority</dt>
            <dd>{row.priority ?? 'Unset'}</dd>
            <dt>Concurrent streams</dt>
            <dd>
              {row.maxConcurrent == null
                ? 'Default'
                : row.maxConcurrent === 0
                  ? 'Ungated'
                  : row.maxConcurrent}
            </dd>
            {scope.model ? (
              <>
                <dt>Admission for {scope.model}</dt>
                <dd>
                  {verdict?.verdict || 'Unknown'}
                  {verdict?.reasons?.length
                    ? ` · ${verdict.reasons.map((reason) => reason.label).join('; ')}`
                    : ''}
                </dd>
              </>
            ) : null}
          </dl>
          <dl className={shared.facts}>
            <dt>Attempts in scope</dt>
            <dd>{number(record?.records)}</dd>
            <dt>Failed</dt>
            <dd>{number(record?.failed)}</dd>
            <dt>Input tokens</dt>
            <dd>{number(observedTokens(record, 'inputTokens', 'inputSamples'))}</dd>
            <dt>Cached reads</dt>
            <dd>{number(observedTokens(record, 'cacheReadTokens', 'cacheReadSamples'))}</dd>
            <dt>Cache writes</dt>
            <dd>{number(observedTokens(record, 'cacheWriteTokens', 'cacheWriteSamples'))}</dd>
            <dt>Output tokens</dt>
            <dd>{number(observedTokens(record, 'outputTokens', 'outputSamples'))}</dd>
          </dl>
        </div>
        {row.lastError ? (
          <Text size="xs" c="orange.8" mt="xs">
            {row.lastError}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed" mt="xs">
          Recorded status comes from stored test results, errors and local gates. It does not
          establish model support or available quota.
        </Text>
        <Button
          mt="xs"
          size="xs"
          variant="subtle"
          onClick={() => setScope({ connectionId: row.connectionId })}
          rightSection={<Icon name="i-right" />}
        >
          Use as shared scope
        </Button>
      </Tabs.Panel>
      <Tabs.Panel value="quota">
        {windows.length ? (
          <ScrollArea
            viewportProps={{
              tabIndex: 0,
              role: 'region',
              'aria-label': 'Scroll current quota windows',
            }}
          >
            <QuotaTable windows={windows} anchor={anchor} selectedScope={selectedScope} />
          </ScrollArea>
        ) : (
          <Text size="xs" c="dimmed">
            No quota windows were recorded for this account.
          </Text>
        )}
        <QuotaAcquisitionControls key={row.connectionId} account={row} />
        <QuotaHistoryWorkbench account={row} anchor={anchor} selectedScope={selectedScope} />
      </Tabs.Panel>
      <Tabs.Panel value="requests">
        {requests.loading ? (
          <Loader size="xs" />
        ) : requests.error ? (
          <Text c="red" size="xs">
            {requests.error}
          </Text>
        ) : (
          <ScrollArea
            viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Recent account attempts' }}
          >
            <Table striped miw={620} className={styles.evidenceTable}>
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
                    <Table.Td>
                      {capacityAttemptSelection(item) ? (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => inspectAttempt(item)}
                        >
                          Inspect
                        </Button>
                      ) : (
                        <span className={styles.muted}>No retained link</span>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <bdi>{item.requestedModel || 'Unknown'}</bdi>
                    </Table.Td>
                    <Table.Td>
                      <bdi>{item.model || 'Unknown'}</bdi>
                    </Table.Td>
                    <Table.Td>{item.status}</Table.Td>
                    <Table.Td>{number(item.inputTokens)}</Table.Td>
                    <Table.Td>{number(item.cacheReadTokens)}</Table.Td>
                    <Table.Td>{number(item.outputTokens)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Tabs.Panel>
      <Tabs.Panel value="policy">
        <AccountPolicyEvidence account={row} />
      </Tabs.Panel>
    </Tabs>
  );
}
