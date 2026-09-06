'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Button,
  Group,
  Loader,
  NumberInput,
  Pagination,
  ScrollArea,
  Select,
  Switch,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useWorkspace } from './WorkspaceProvider';
import { useResource } from './useResource';
import { AnalyticalChart } from './AnalyticalChart';
import { projectQuotaScenario } from '@/lib/db/analytics/quotaTrend.mjs';
import {
  QUOTA_TREND_EXPLANATIONS,
  observationZoom,
  quotaChecksUrl,
  quotaNumber,
  quotaObservationOption,
  quotaTimestamp,
  quotaWorkbenchUrl,
} from './quotaWorkbenchModel';
import styles from './quotaHistoryWorkbench.module.css';

function Freshness({ value }) {
  if (!value) return null;
  return (
    <Text size="xs" c="dimmed">
      {value.source === 'last-persisted-snapshot'
        ? `Persisted file ${quotaTimestamp(value.persistedAt)}`
        : `Committed snapshot ${quotaTimestamp(value.snapshotCompletedAt)}`}{' '}
      UTC.
    </Text>
  );
}

function Scenario({ analysis }) {
  const [multiplier, setMultiplier] = useState(1),
    [available, setAvailable] = useState(true);
  const valid = typeof multiplier === 'number' && multiplier >= 0.1 && multiplier <= 10;
  const result = valid ? projectQuotaScenario(analysis, { multiplier, available }) : null;
  return (
    <section className={styles.scenario} aria-label="Quota exhaustion scenario">
      <h4>Exhaustion scenario</h4>
      <p className={styles.note}>
        Scale the observed consumption rate. This assumes unchanged request mix, cache behavior and
        provider charging.
      </p>
      <Group gap="md" align="end" className={styles.controls}>
        <NumberInput
          label="Workload multiplier"
          value={multiplier}
          onChange={setMultiplier}
          min={0.1}
          max={10}
          step={0.1}
          decimalScale={2}
          suffix=" ×"
          clampBehavior="strict"
          w={160}
        />
        <Switch
          label="Include this account"
          checked={available}
          onChange={(event) => setAvailable(event.currentTarget.checked)}
        />
      </Group>
      <div className={styles.result} aria-live="polite">
        {!valid ? (
          <p>Enter a multiplier from 0.1 to 10.</p>
        ) : !available ? (
          <p>
            This account is excluded from the scenario. Redistribution to other accounts has not
            been simulated.
          </p>
        ) : analysis.state !== 'available' ? (
          <>
            <strong>Forecast unavailable</strong>
            <p>
              {QUOTA_TREND_EXPLANATIONS[analysis.state] ||
                'This evidence cannot support a forecast.'}
            </p>
          </>
        ) : result.state === 'reset_before_exhaustion' ? (
          <>
            <strong>Reset deadline comes first</strong>
            <p>
              The linear projection reaches zero at {quotaTimestamp(result.projectedWithoutResetAt)}{' '}
              UTC, beyond the recorded reset deadline. Replenishment has not been assumed.
            </p>
          </>
        ) : (
          <>
            <strong>
              {result.deadlineBeforeAsOf
                ? 'Scenario deadline already passed'
                : 'Projected exhaustion'}
              <span className={styles.value}>{quotaTimestamp(result.exhaustionAt)} UTC</span>
            </strong>
            <p>
              Observed-rate sensitivity from {quotaTimestamp(result.earliestAt)} to{' '}
              {result.latestAt
                ? `${quotaTimestamp(result.latestAt)} UTC`
                : 'an unbounded or reset-limited late horizon'}
              . This is not a confidence interval.
            </p>
            {result.deadlineBeforeAsOf && (
              <p>A fresh observation is needed to determine whether quota actually ran out.</p>
            )}
          </>
        )}
      </div>
      <dl className={styles.facts}>
        <dt>Latest observed balance</dt>
        <dd>
          {quotaNumber(analysis.last?.value)} {analysis.unit || 'unknown units'}
        </dd>
        <dt>Balance observed (UTC)</dt>
        <dd>{quotaTimestamp(analysis.last?.observedAt)}</dd>
        <dt>Median consumption</dt>
        <dd>
          {analysis.rate
            ? `${quotaNumber(analysis.rate.median)} ${analysis.rate.unit}`
            : 'Unavailable'}
        </dd>
        <dt>Current segment</dt>
        <dd>
          {quotaNumber(analysis.segmentSampleCount)} observations
          {analysis.spanMs != null ? ` over ${quotaNumber(analysis.spanMs / 60_000)} min` : ''}
        </dd>
        <dt>Observation age at range end</dt>
        <dd>
          {analysis.observationAgeMs != null
            ? `${quotaNumber(analysis.observationAgeMs / 60_000)} min`
            : 'Unknown'}
        </dd>
        <dt>Stale after</dt>
        <dd>
          {analysis.staleAfterMs != null
            ? `${quotaNumber(analysis.staleAfterMs / 60_000)} min`
            : 'Insufficient cadence evidence'}
        </dd>
        <dt>Recorded reset (UTC)</dt>
        <dd>{quotaTimestamp(analysis.resetAt)}</dd>
      </dl>
      <p className={styles.note}>
        Local calculation only. No account, route or quota settings change.
      </p>
      <Button component={Link} href="/dashboard/models" variant="subtle" size="compact-sm">
        Compare route policy
      </Button>
    </section>
  );
}

function ObservationSeries({ series }) {
  const [selectedId, setSelectedId] = useState(null),
    [zoom, setZoom] = useState(null),
    [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      series.points
        .filter(
          (point) =>
            !zoom ||
            (point.observedAt &&
              Date.parse(point.observedAt) >= zoom[0] &&
              Date.parse(point.observedAt) <= zoom[1])
        )
        .toSorted(
          (a, b) =>
            String(b.observedAt || '').localeCompare(String(a.observedAt || '')) ||
            b.id.localeCompare(a.id)
        ),
    [series.points, zoom]
  );
  const actualPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 10)));
  const selected = series.points.find((point) => point.id === selectedId);
  const option = useMemo(
    () => quotaObservationOption(series, selectedId, zoom),
    [series, selectedId, zoom]
  );
  const select = (id) => {
    setSelectedId(id);
    const index = filtered.findIndex((point) => point.id === id);
    if (index >= 0) setPage(Math.floor(index / 10) + 1);
  };
  return (
    <>
      <div className={styles.analysisGrid}>
        <section className={styles.observations} aria-label="Quota observation analysis">
          <Group justify="space-between">
            <h4>Observed {series.analysis.unit || 'balance'}</h4>
            <Text size="xs" c="dimmed">
              {quotaNumber(series.coverage.measured)} measured /{' '}
              {quotaNumber(series.coverage.records)} records
            </Text>
          </Group>
          <AnalyticalChart
            option={option}
            height={200}
            label={`Retained ${series.scope} observations in ${series.analysis.unit || 'unknown units'}. UTC observation time. Points do not establish continuous monitoring.`}
            onEvents={{
              click: (event) => event.data?.id && select(event.data.id),
              datazoom: (event) => {
                setZoom(observationZoom(event, series));
                setPage(1);
              },
            }}
          />
          <Group justify="space-between">
            <p className={styles.note}>
              Observation time (UTC). Zoom filters the contributing rows below.
            </p>
            {zoom && (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  setZoom(null);
                  setPage(1);
                }}
              >
                Clear observation zoom
              </Button>
            )}
          </Group>
          <ScrollArea>
            <Table className={styles.table} aria-label="Contributing quota observations">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Observed (UTC)</Table.Th>
                  <Table.Th>Balance</Table.Th>
                  <Table.Th>Captured (UTC)</Table.Th>
                  <Table.Th>Evidence</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.slice((actualPage - 1) * 10, actualPage * 10).map((point) => (
                  <Table.Tr key={point.id} data-selected={point.id === selectedId || undefined}>
                    <Table.Td>
                      <UnstyledButton
                        aria-label={`Inspect quota observation ${point.id}`}
                        aria-pressed={point.id === selectedId}
                        onClick={() => select(point.id)}
                      >
                        {quotaTimestamp(point.observedAt)}
                      </UnstyledButton>
                    </Table.Td>
                    <Table.Td>{quotaNumber(point.value)}</Table.Td>
                    <Table.Td>{quotaTimestamp(point.capturedAt)}</Table.Td>
                    <Table.Td>{point.confidence || 'Unknown'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
          <Group justify="space-between" mt="xs">
            <Text size="xs" c="dimmed">
              {quotaNumber(filtered.length)} contributing records
              {zoom ? ' in this observation zoom' : ''}
            </Text>
            <Pagination
              total={Math.ceil(filtered.length / 10)}
              value={actualPage}
              onChange={setPage}
              size="xs"
              aria-label="Quota observation pages"
            />
          </Group>
          {selected && (
            <div className={styles.selected} aria-label="Selected quota observation">
              <strong>Selected observation</strong>
              <code>{selected.id}</code>
              <p>
                {quotaNumber(selected.value)} {series.analysis.unit || 'unknown units'} observed{' '}
                {quotaTimestamp(selected.observedAt)} UTC. Recorded reset{' '}
                {quotaTimestamp(selected.resetAt)} UTC.
              </p>
              {!filtered.some((point) => point.id === selectedId) && (
                <p>This selection is outside the current observation zoom.</p>
              )}
            </div>
          )}
          {series.analysis.increases.length > 0 && (
            <details className={styles.increases}>
              <summary>{series.analysis.increases.length} observed balance increases</summary>
              <p className={styles.note}>
                An increase does not prove a reset or successful warming request.
              </p>
              <ul>
                {series.analysis.increases.map((increase) => (
                  <li key={increase.afterId}>
                    +{quotaNumber(increase.amount)} {increase.unit} at{' '}
                    {quotaTimestamp(increase.observedAt)} UTC
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
        <Scenario analysis={series.analysis} />
      </div>
    </>
  );
}

function ResetChecks({ analysisUrl, onSnapshot }) {
  const [page, setPage] = useState(1),
    [eventType, setEventType] = useState(null);
  const resource = useResource(quotaChecksUrl(analysisUrl, page, eventType), { onSnapshot });
  return (
    <section className={styles.checks} aria-label="Reset planning evidence">
      <Group justify="space-between" align="start">
        <div>
          <h4>Reset planning and check history</h4>
          <p className={styles.note}>
            Scheduling decisions, recorded execution and outcomes. A scheduling record does not
            prove that a check is still queued.
          </p>
        </div>
        <Select
          aria-label="Reset event type"
          placeholder="All recorded events"
          clearable
          value={eventType}
          onChange={(value) => {
            setEventType(value);
            setPage(1);
          }}
          data={[
            'scheduled',
            'started',
            'usage-read',
            'failed',
            'warm-response',
            'warm-recorded',
            'clock-running',
            'still-cold',
            'completed',
          ].map((value) => ({ value, label: value.replaceAll('-', ' ') }))}
          w={200}
        />
      </Group>
      {resource.loading ? (
        <Loader size="sm" mt="sm" />
      ) : resource.error ? (
        <Alert color="orange" title="Check history unavailable">
          {resource.error}
          <Button variant="subtle" size="compact-sm" onClick={resource.refresh}>
            Retry history
          </Button>
        </Alert>
      ) : !resource.data?.items?.length ? (
        <p className={styles.empty}>No matching check events were retained in this period.</p>
      ) : (
        <>
          <ScrollArea>
            <Table className={styles.table} aria-label="Recorded quota reset checks">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Recorded (UTC)</Table.Th>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Scheduled for (UTC)</Table.Th>
                  <Table.Th>Scope</Table.Th>
                  <Table.Th>Outcome code</Table.Th>
                  <Table.Th>Check identifier</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {resource.data.items.map((event) => (
                  <Table.Tr key={event.id}>
                    <Table.Td>{quotaTimestamp(event.capturedAt)}</Table.Td>
                    <Table.Td>{event.eventType.replaceAll('-', ' ')}</Table.Td>
                    <Table.Td>{quotaTimestamp(event.scheduledFor)}</Table.Td>
                    <Table.Td>{event.scope || 'Not recorded'}</Table.Td>
                    <Table.Td>{event.code || 'Not recorded'}</Table.Td>
                    <Table.Td>
                      <code title={event.checkId}>{event.checkId}</code>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
          <Group justify="space-between" mt="xs">
            <Text size="xs" c="dimmed">
              {quotaNumber(resource.data.total)} matching retained events
            </Text>
            <Pagination
              total={resource.data.pages}
              value={page}
              onChange={setPage}
              size="xs"
              aria-label="Reset check pages"
            />
          </Group>
        </>
      )}
      <Freshness value={resource.data?.freshness} />
    </section>
  );
}

export function QuotaHistoryWorkbench({ account, anchor, selectedScope }) {
  const { scope, observeSnapshot, setSelectedAccountId } = useWorkspace();
  const url = quotaWorkbenchUrl(scope, account.connectionId, anchor);
  const resource = useResource(url, { onSnapshot: observeSnapshot });
  const [activeId, setActiveId] = useState(null);
  const series = resource.data?.series || [];
  const active =
    series.find(
      (item) => item.id === activeId && (!selectedScope || item.scope === selectedScope)
    ) ||
    series.find((item) => item.scope === selectedScope) ||
    series[0];
  return (
    <section className={styles.workbench} aria-label="Quota history workbench">
      <Group justify="space-between">
        <div>
          <h3>Quota history</h3>
          <p className={styles.note}>
            Captured in the shared time range. Historical balances are shown at their source
            observation times.
          </p>
        </div>
        <Button variant="subtle" size="compact-sm" onClick={resource.refresh}>
          Refresh history
        </Button>
      </Group>
      {scope.model && (
        <p className={styles.notice}>
          The shared model filter is preserved. Quota observations have no model attribution and are
          shown for the selected account.
        </p>
      )}
      {resource.loading ? (
        <Loader size="sm" mt="md" />
      ) : resource.error ? (
        <Alert color="orange" title="Quota analysis unavailable">
          {resource.error}
        </Alert>
      ) : !resource.data?.complete ? (
        <Alert color="orange" title="Complete analysis unavailable">
          {resource.data?.instruction} {quotaNumber(resource.data?.total)} observations match this
          scope; no partial-data forecast is calculated.
        </Alert>
      ) : !series.length ? (
        <p className={styles.empty}>
          No quota observations were retained for this account in the selected period. Rechecking an
          account records future evidence; history cannot be reconstructed.
        </p>
      ) : (
        <>
          <Select
            label="Reported quota window"
            value={active.id}
            onChange={(id) => {
              const chosen = series.find((item) => item.id === id);
              if (chosen) {
                setActiveId(id);
                setSelectedAccountId(account.connectionId, chosen.scope);
              }
            }}
            data={series.map((item) => ({
              value: item.id,
              label: `${item.scope} · ${item.analysis.unit || 'unknown unit'} · ${item.resourceType || 'resource unknown'} · ${item.source}`,
            }))}
            className={styles.windowSelect}
            searchable
          />
          <ObservationSeries key={`${url}:${active.id}`} series={active} />
        </>
      )}
      <Freshness value={resource.data?.freshness} />
      <ResetChecks key={url} analysisUrl={url} onSnapshot={observeSnapshot} />
    </section>
  );
}
