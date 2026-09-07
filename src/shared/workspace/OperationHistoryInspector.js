'use client';
import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Loader,
  Pagination,
  ScrollArea,
  Select,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useResource } from './useResource';
import {
  NOT_RECORDED,
  OPERATION_CODES,
  OPERATION_STATES,
  operationHistoryLimits,
  operationHistoryUrl,
  operationNumber,
  operationTimestamp,
  operationText,
  resolveOperationRows,
} from './operationHistoryModel';
import styles from './operationHistoryInspector.module.css';

function Freshness({ value }) {
  if (!value) return null;
  return (
    <Text size="xs" c="dimmed">
      {value.source === 'last-persisted-snapshot'
        ? `Persisted file ${operationTimestamp(value.persistedAt)}`
        : `Committed snapshot ${operationTimestamp(value.snapshotCompletedAt)}`}{' '}
      UTC.
    </Text>
  );
}

// A measured value, right-aligned tabular mono, or the word for its absence.
function Measured({ value, unit }) {
  if (value === null || value === undefined)
    return <span className={styles.unknown}>{NOT_RECORDED}</span>;
  return (
    <span className={styles.measure}>
      {operationNumber(value)}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

function Flag({ value, when, absent }) {
  if (typeof value !== 'boolean') return <span className={styles.unknown}>{NOT_RECORDED}</span>;
  return <>{value ? when : absent}</>;
}

function Selected({ row }) {
  const { presentation, details } = row;
  return (
    <section className={styles.selected} aria-label="Selected operation event">
      <h4>What this row means</h4>
      <p className={styles.state} data-tone={presentation.tone}>
        {presentation.label}
      </p>
      <code className={styles.operationId}>{row.operationId}</code>
      <p>{presentation.meaning}</p>
      <h5>Effect on activation</h5>
      <p>{presentation.activation}</p>
      {row.code ? (
        <>
          <h5>Recorded code</h5>
          <p>
            <code className={styles.code}>{row.code}</code>{' '}
            {OPERATION_CODES[row.code] || 'This code has no explanation on this screen.'}
          </p>
        </>
      ) : null}
      <h5>Retained detail</h5>
      <dl className={styles.facts}>
        <dt>Upstream status</dt>
        <dd>
          <Measured value={details?.status ?? null} />
        </dd>
        <dt>Elapsed</dt>
        <dd>
          <Measured value={details?.elapsedMs ?? null} unit="ms" />
        </dd>
        <dt>Probe kind</dt>
        <dd>{operationText(details?.kind)}</dd>
        <dt>Pool type</dt>
        <dd>{operationText(details?.poolType)}</dd>
        <dt>Reached its deadline</dt>
        <dd>
          <Flag value={details?.timedOut} when="Yes" absent="No" />
        </dd>
        <dt>Caller cancelled it</dt>
        <dd>
          <Flag value={details?.cancelled} when="Yes" absent="No" />
        </dd>
        <dt>Configuration conflict</dt>
        <dd>
          <Flag
            value={details?.conflict}
            when="Yes, the result was discarded"
            absent="None recorded"
          />
        </dd>
      </dl>
    </section>
  );
}

/**
 * Retained probe history for one subject, newest capture first, paged through
 * the bounded analytics query rather than loaded whole.
 *
 * The state column carries the distinction this screen exists for: a start
 * whose terminal receipt never arrived reads as unresolved, which is neither a
 * success nor a failure, and the copy says so instead of implying the probe
 * can simply be run again.
 */
export function OperationHistoryInspector({ subjectId, subjectKind = 'proxyPool', label }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const resource = useResource(operationHistoryUrl(subjectId, page, { subjectKind, state }));
  // Page and selection are per-subject state. Rather than resetting them in an
  // effect when subjectId changes (a cascading render), the caller keys this
  // component on the subject so a different subject is a fresh mount.
  const rows = resolveOperationRows(resource.data?.items);
  const selected = rows.find((row) => row.id === selectedId);
  const unresolvedCount = rows.filter((row) => row.unresolved).length;
  return (
    <section className={styles.inspector} aria-label="Probe operation history">
      <Group justify="space-between" align="start" wrap="wrap">
        <div className={styles.head}>
          <h3>Probe history</h3>
          <p className={styles.note}>
            Retained receipts for {label ? <strong>{label}</strong> : 'this pool'}, newest capture
            first. Each row is evidence that was written at the time; it is not re-derived from the
            pool as it stands now.
          </p>
        </div>
        <Group gap="sm" align="end">
          <Select
            label="Recorded state"
            aria-label="Filter recorded operation state"
            placeholder="All recorded states"
            clearable
            clearButtonProps={{ 'aria-label': 'Clear operation state filter' }}
            value={state}
            onChange={(value) => {
              setState(value);
              setPage(1);
              setSelectedId(null);
            }}
            data={OPERATION_STATES.map((value) => ({ value, label: value }))}
            className={styles.filter}
          />
          <Button variant="subtle" size="compact-sm" onClick={resource.refresh}>
            Refresh history
          </Button>
        </Group>
      </Group>

      {resource.loading ? (
        <Loader size="sm" mt="sm" />
      ) : resource.error ? (
        <Alert color="orange" title="Probe history unavailable">
          {resource.error}
          <div>
            <Button variant="subtle" size="compact-sm" onClick={resource.refresh}>
              Retry history
            </Button>
          </div>
        </Alert>
      ) : !rows.length ? (
        <p className={styles.empty}>
          No probe event for this pool was captured in the read window. History cannot be
          reconstructed for a probe that ran before events were retained; a probe run from now on
          records its own receipt.
        </p>
      ) : (
        <>
          {unresolvedCount > 0 ? (
            <p className={styles.unresolvedBanner} role="status">
              {operationNumber(unresolvedCount)} of these operations recorded a start with no
              terminal receipt. Each one is unresolved after an interruption. That is neither a
              success nor a failure, and it is not permission to resend the check.
            </p>
          ) : null}
          <div className={styles.grid}>
            <div className={styles.tableColumn}>
              <ScrollArea
                viewportProps={{
                  tabIndex: 0,
                  role: 'region',
                  'aria-label': 'Scroll retained probe events',
                }}
              >
                <Table className={styles.table} aria-label="Retained probe events">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Operation</Table.Th>
                      <Table.Th>Phase</Table.Th>
                      <Table.Th>State</Table.Th>
                      <Table.Th>Occurred (UTC)</Table.Th>
                      <Table.Th>Captured (UTC)</Table.Th>
                      <Table.Th>Actor</Table.Th>
                      <Table.Th>Source</Table.Th>
                      <Table.Th>Code</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((row) => (
                      <Table.Tr
                        key={row.id}
                        data-selected={row.id === selectedId || undefined}
                        data-kind={row.presentation.kind}
                      >
                        <Table.Td>
                          <UnstyledButton
                            className={styles.rowButton}
                            aria-label={`Inspect operation ${row.operationId} ${row.phase}`}
                            aria-pressed={row.id === selectedId}
                            onClick={() => setSelectedId(row.id)}
                          >
                            <code>{row.operationId}</code>
                          </UnstyledButton>
                        </Table.Td>
                        <Table.Td>{operationText(row.phase)}</Table.Td>
                        <Table.Td>
                          <span className={styles.state} data-tone={row.presentation.tone}>
                            {row.presentation.label}
                          </span>
                        </Table.Td>
                        <Table.Td className={styles.time}>
                          {operationTimestamp(row.occurredAt)}
                        </Table.Td>
                        <Table.Td className={styles.time}>
                          {operationTimestamp(row.capturedAt)}
                        </Table.Td>
                        <Table.Td>{operationText(row.actorClass)}</Table.Td>
                        <Table.Td>{operationText(row.source)}</Table.Td>
                        <Table.Td>
                          {row.code ? (
                            <code className={styles.code}>{row.code}</code>
                          ) : (
                            <span className={styles.unknown}>{NOT_RECORDED}</span>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
              <Group justify="space-between" mt="xs" wrap="wrap">
                <Text size="xs" c="dimmed">
                  {operationNumber(resource.data?.total)} matching retained events, page{' '}
                  {operationNumber(resource.data?.page)} of {operationNumber(resource.data?.pages)}
                </Text>
                <Pagination
                  total={resource.data?.pages || 1}
                  value={page}
                  onChange={(next) => {
                    setPage(next);
                    setSelectedId(null);
                  }}
                  size="xs"
                  aria-label="Probe history pages"
                  getControlProps={(control) => ({ 'aria-label': `${control} probe history page` })}
                  getItemProps={(item) => ({ 'aria-label': `Probe history page ${item}` })}
                />
              </Group>
            </div>
            {selected ? (
              <Selected row={selected} />
            ) : (
              <p className={styles.hint}>
                Select an operation id to read what its state means and what it did to activation.
              </p>
            )}
          </div>
        </>
      )}

      <details className={styles.limits}>
        <summary>What this history does not tell you</summary>
        <ul>
          {operationHistoryLimits(resource.data?.timeRange).map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
      <Freshness value={resource.data?.freshness} />
    </section>
  );
}
