'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Button,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useResource } from './useResource';
import {
  ALERT_STATE_LABEL,
  DEFAULT_RULE,
  DRY_RUN_STATE_EXPLANATION,
  EVIDENCE_LABEL,
  UNKNOWN,
  alertState,
  evidenceHref,
  humanDuration,
  ruleNumber,
  ruleSentence,
  ruleTimestamp,
  scopeLabel,
} from './notificationRulesModel';
import styles from './notificationRules.module.css';

const ENDPOINT = '/api/admin/notification-rules';

async function send(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function Facts({ rows }) {
  return (
    <dl className={styles.facts}>
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd data-unknown={value === UNKNOWN || undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RuleEditor({ rule, conditions, onCancel, onSaved, onStale }) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_RULE, ...rule }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const condition = conditions.find((entry) => entry.kind === draft.conditionKind);
  const editing = Boolean(rule?.id);

  const set = (patch) => setDraft((old) => ({ ...old, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const body = {
        name: draft.name,
        conditionKind: draft.conditionKind,
        scopeKind: draft.scopeKind,
        scopeId: draft.scopeKind === 'global' ? null : draft.scopeId,
        threshold: Number(draft.threshold),
        durationSeconds: Number(draft.durationSeconds),
        cooldownSeconds: Number(draft.cooldownSeconds),
        enabled: draft.enabled,
      };
      const saved = editing
        ? await send(`${ENDPOINT}/${rule.id}`, 'PUT', { ...body, revision: rule.revision })
        : await send(ENDPOINT, 'POST', body);
      onSaved(saved);
    } catch (caught) {
      // A revision conflict is shown as a conflict, with the live values, so
      // the operator decides. It is never resolved by overwriting.
      if (caught.status === 409) {
        setConflict(caught.payload);
        // The table behind this editor is now showing a stale revision, so
        // refresh it rather than leaving two disagreeing numbers on screen.
        onStale?.();
      } else setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.editor} onSubmit={submit} aria-label="Notification rule editor">
      <h4>{editing ? 'Edit rule' : 'New rule'}</h4>
      <Group gap="md" align="start" wrap="wrap">
        <TextInput
          label="Name"
          value={draft.name}
          onChange={(event) => set({ name: event.currentTarget.value })}
          w={260}
          required
          maxLength={120}
        />
        <Select
          label="Condition"
          value={draft.conditionKind}
          onChange={(value) => {
            const next = conditions.find((entry) => entry.kind === value);
            set({
              conditionKind: value,
              // Snap the threshold into the new condition's declared range
              // rather than carrying an out-of-range value across.
              threshold: next
                ? Math.min(
                    Math.max(draft.threshold, next.thresholdRange[0]),
                    next.thresholdRange[1]
                  )
                : draft.threshold,
            });
          }}
          data={conditions.map((entry) => ({ value: entry.kind, label: entry.label }))}
          w={280}
        />
      </Group>
      {condition && <p className={styles.note}>{condition.description}</p>}
      <Group gap="md" align="start" wrap="wrap">
        <Select
          label="Scope"
          value={draft.scopeKind}
          onChange={(value) => set({ scopeKind: value })}
          data={[
            { value: 'global', label: 'Every subject' },
            { value: 'connection', label: 'One account' },
            { value: 'provider', label: 'One provider' },
          ]}
          w={200}
        />
        {draft.scopeKind !== 'global' && (
          <TextInput
            label={draft.scopeKind === 'connection' ? 'Account id' : 'Provider'}
            value={draft.scopeId || ''}
            onChange={(event) => set({ scopeId: event.currentTarget.value })}
            w={260}
            required
            classNames={{ input: styles.mono }}
          />
        )}
      </Group>
      <Group gap="md" align="end" wrap="wrap">
        <NumberInput
          label={`Threshold${condition ? ` (${condition.unit})` : ''}`}
          value={draft.threshold}
          onChange={(value) => set({ threshold: value })}
          min={condition?.thresholdRange[0]}
          max={condition?.thresholdRange[1]}
          decimalScale={2}
          w={200}
        />
        <NumberInput
          label={condition?.durationRole === 'window' ? 'Window (seconds)' : 'Sustained (seconds)'}
          value={draft.durationSeconds}
          onChange={(value) => set({ durationSeconds: value })}
          min={1}
          step={60}
          w={190}
        />
        <NumberInput
          label="Cooldown (seconds)"
          value={draft.cooldownSeconds}
          onChange={(value) => set({ cooldownSeconds: value })}
          min={60}
          step={60}
          w={190}
        />
        <Switch
          label="Enabled"
          checked={draft.enabled}
          onChange={(event) => set({ enabled: event.currentTarget.checked })}
        />
      </Group>
      {condition && <p className={styles.sentence}>{ruleSentence(draft, condition)}</p>}
      {conflict && (
        <Alert color="indigo" title="This rule was changed by someone else">
          <p>
            You edited revision {ruleNumber(conflict.expectedRevision)}. The stored rule is now at
            revision {ruleNumber(conflict.current?.revision)}, with a threshold of{' '}
            {ruleNumber(conflict.current?.threshold)} and a{' '}
            {humanDuration(conflict.current?.durationSeconds)} duration. Your change was not
            applied.
          </p>
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() => {
              setDraft({ ...DEFAULT_RULE, ...conflict.current });
              setConflict(null);
            }}
          >
            Load the stored rule and start again
          </Button>
        </Alert>
      )}
      {error && (
        <Alert color="orange" title="This rule was not saved">
          {error}
        </Alert>
      )}
      <Group gap="sm" mt="sm">
        <Button type="submit" size="compact-sm" loading={busy}>
          {editing ? 'Save rule' : 'Create rule'}
        </Button>
        <Button size="compact-sm" variant="subtle" onClick={onCancel} type="button">
          Cancel
        </Button>
      </Group>
    </form>
  );
}

function DryRun({ rule, conditions }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const condition = conditions.find((entry) => entry.kind === rule.conditionKind);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await send(`${ENDPOINT}/dry-run`, 'POST', { rule }));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.dryRun} aria-label="Rule dry run">
      <Group justify="space-between" align="start">
        <div>
          <h4>Dry run against retained history</h4>
          <p className={styles.note}>
            Replays this rule over the records this installation still retains and lists what it
            would have alerted on. Nothing is sent, nothing is stored, and no account or route is
            touched. Periods with no retained evidence cannot be evaluated and are reported as such.
          </p>
        </div>
        <Button size="compact-sm" variant="default" onClick={run} loading={busy}>
          Run against history
        </Button>
      </Group>
      {error && (
        <Alert color="orange" title="Dry run unavailable">
          {error}
        </Alert>
      )}
      {result && (
        <>
          <Facts
            rows={[
              ['Retained records examined', ruleNumber(result.total)],
              ['Would have alerted', ruleNumber(result.firingCount)],
              ['Range start (UTC)', ruleTimestamp(result.timeRange?.start)],
              ['Range end (UTC)', ruleTimestamp(result.timeRange?.end)],
            ]}
          />
          {!result.complete ? (
            <Alert color="orange" title="Complete evaluation unavailable">
              {ruleNumber(result.total)} records match this scope, above the{' '}
              {ruleNumber(result.limit)} row ceiling for one evaluation. Narrow the range; no
              partial verdict is calculated.
            </Alert>
          ) : result.evidenceAbsent ? (
            <p className={styles.empty}>
              No records of this kind were retained for this scope in the range. This is an absence
              of evidence, not evidence that the condition never held.
            </p>
          ) : (
            <ScrollArea
              viewportProps={{
                tabIndex: 0,
                role: 'region',
                'aria-label': 'Scroll dry run results',
              }}
            >
              <Table className={styles.table} aria-label="Dry run results by subject">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Subject</Table.Th>
                    <Table.Th className={styles.numeric}>Records</Table.Th>
                    <Table.Th className={styles.numeric}>Measured</Table.Th>
                    <Table.Th className={styles.numeric}>Would alert</Table.Th>
                    <Table.Th>First firing (UTC)</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {result.groups.map((group) => (
                    <Table.Tr key={group.scopeKey}>
                      <Table.Td>
                        <code title={group.scopeKey}>{group.scopeKey}</code>
                      </Table.Td>
                      <Table.Td className={styles.numeric}>
                        {ruleNumber(group.sampleCount)}
                      </Table.Td>
                      <Table.Td
                        className={styles.numeric}
                        data-unknown={group.measuredCount === 0 || undefined}
                      >
                        {ruleNumber(group.measuredCount)}
                      </Table.Td>
                      <Table.Td className={styles.numeric}>
                        {ruleNumber(group.firings.length)}
                      </Table.Td>
                      <Table.Td>
                        {group.firings.length
                          ? ruleTimestamp(group.firings[0].firedAt)
                          : DRY_RUN_STATE_EXPLANATION[group.state] || UNKNOWN}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
          {result.groups.some((group) => group.firings.length > 0) && (
            <details className={styles.firings}>
              <summary>
                {ruleNumber(result.firingCount)} historical firings and their triggering records
              </summary>
              <ul>
                {result.groups.flatMap((group) =>
                  group.firings.map((firing) => (
                    <li key={`${group.scopeKey}:${firing.firedAt}`}>
                      <code>{group.scopeKey}</code> at {ruleTimestamp(firing.firedAt)} UTC, breach
                      from {ruleTimestamp(firing.breachStartedAt)}, measured{' '}
                      {ruleNumber(firing.observedValue)} {condition?.unit || ''} across{' '}
                      {ruleNumber(firing.sampleCount)}{' '}
                      {EVIDENCE_LABEL[condition?.evidenceKind] || 'record'}
                      {firing.sampleCount === 1 ? '' : 's'}.
                    </li>
                  ))
                )}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function AlertRow({ event, conditions, rules, onChanged }) {
  const [busy, setBusy] = useState(false);
  const rule = rules.find((entry) => entry.id === event.ruleId);
  const condition = conditions.find((entry) => entry.kind === rule?.conditionKind);
  const state = alertState(event);
  const act = async (body) => {
    setBusy(true);
    try {
      await send(`${ENDPOINT}/events/${event.id}`, 'POST', body);
      onChanged();
    } catch {
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const href = evidenceHref(event.evidence?.kind, event.evidence?.refs?.[0], event);
  return (
    <Table.Tr data-state={state}>
      <Table.Td>{ruleTimestamp(event.firedAt)}</Table.Td>
      <Table.Td>{rule?.name || 'Rule deleted'}</Table.Td>
      <Table.Td>
        <code title={event.scopeKey}>{event.scopeKey}</code>
      </Table.Td>
      <Table.Td>
        {ruleNumber(event.observedValue)}
        {condition ? ` ${condition.unit}` : ''}
      </Table.Td>
      <Table.Td>
        <span className={styles.state} data-state={state}>
          {ALERT_STATE_LABEL[state]}
        </span>
        {state === 'snoozed' && (
          <Text size="xs" c="dimmed">
            until {ruleTimestamp(event.snoozedUntil)}
          </Text>
        )}
      </Table.Td>
      {/* data-unknown carries the dim treatment in the module, so the cell
          needs it whenever it falls back to UNKNOWN rather than the word
          being emitted bare. */}
      <Table.Td data-unknown={event.evidence?.refs?.length ? undefined : true}>
        {event.evidence?.refs?.length ? (
          href ? (
            <Link href={href}>
              {ruleNumber(event.evidence.refs.length)}{' '}
              {EVIDENCE_LABEL[event.evidence.kind] || 'record'}
              {event.evidence.refs.length === 1 ? '' : 's'}
            </Link>
          ) : (
            `${ruleNumber(event.evidence.refs.length)} ${EVIDENCE_LABEL[event.evidence.kind] || 'records'}`
          )
        ) : (
          UNKNOWN
        )}
      </Table.Td>
      <Table.Td>
        {event.outcome === 'firing' && (
          <Group gap="xs">
            <UnstyledButton
              className={styles.action}
              disabled={busy}
              onClick={() => act({ action: 'acknowledge' })}
              aria-label={`Acknowledge alert on ${event.scopeKey}`}
            >
              Acknowledge
            </UnstyledButton>
            <UnstyledButton
              className={styles.action}
              disabled={busy}
              onClick={() =>
                act({
                  action: 'snooze',
                  until: new Date(Date.now() + 86_400_000).toISOString(),
                })
              }
              aria-label={`Snooze alert on ${event.scopeKey} for a day`}
            >
              Snooze 24h
            </UnstyledButton>
          </Group>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

export function NotificationRules() {
  const resource = useResource(ENDPOINT);
  const [editing, setEditing] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const rules = useMemo(() => resource.data?.rules || [], [resource.data]);
  const conditions = useMemo(() => resource.data?.conditions || [], [resource.data]);
  const events = useMemo(() => resource.data?.events || [], [resource.data]);
  const unavailable = resource.data?.unavailableConditions || [];
  const selected = rules.find((rule) => rule.id === selectedId);
  const { refresh } = resource;
  const onSaved = useCallback(() => {
    setEditing(null);
    refresh();
  }, [refresh]);

  return (
    <section className={styles.surface} aria-label="Notification rules">
      <Group justify="space-between" align="start">
        <div>
          <h3>Notification rules</h3>
          <p className={styles.note}>
            Rules watch retained measurements and raise an alert for an operator to read. They never
            change a route, an account or a profile, and they never contact a provider.
          </p>
        </div>
        <Group gap="sm">
          <Button size="compact-sm" variant="subtle" onClick={resource.refresh}>
            Refresh
          </Button>
          <Button
            size="compact-sm"
            onClick={() => {
              setEditing({});
              setSelectedId(null);
            }}
          >
            New rule
          </Button>
        </Group>
      </Group>

      {resource.loading ? (
        <Loader size="sm" mt="md" />
      ) : resource.error ? (
        <Alert color="orange" title="Notification rules unavailable">
          {resource.error}
        </Alert>
      ) : (
        <>
          {editing && (
            <RuleEditor
              key={editing.id || 'new'}
              rule={editing}
              conditions={conditions}
              onCancel={() => setEditing(null)}
              onSaved={onSaved}
              onStale={resource.refresh}
            />
          )}

          {!rules.length ? (
            <p className={styles.empty}>
              No rules are defined. A rule alerts on evidence this installation already retains; it
              cannot reconstruct history it never recorded.
            </p>
          ) : (
            <ScrollArea
              viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Scroll rules' }}
            >
              <Table className={styles.table} aria-label="Notification rules">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Rule</Table.Th>
                    <Table.Th>Condition</Table.Th>
                    <Table.Th>Scope</Table.Th>
                    <Table.Th className={styles.numeric}>Threshold</Table.Th>
                    <Table.Th className={styles.numeric}>Duration</Table.Th>
                    <Table.Th className={styles.numeric}>Cooldown</Table.Th>
                    <Table.Th className={styles.numeric}>Rev</Table.Th>
                    <Table.Th>State</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rules.map((rule) => {
                    const condition = conditions.find((entry) => entry.kind === rule.conditionKind);
                    return (
                      <Table.Tr key={rule.id} data-selected={rule.id === selectedId || undefined}>
                        <Table.Td>
                          <UnstyledButton
                            className={styles.action}
                            aria-pressed={rule.id === selectedId}
                            onClick={() => setSelectedId(rule.id === selectedId ? null : rule.id)}
                          >
                            {rule.name}
                          </UnstyledButton>
                        </Table.Td>
                        <Table.Td>{condition?.label || rule.conditionKind}</Table.Td>
                        <Table.Td>
                          <code>{scopeLabel(rule)}</code>
                        </Table.Td>
                        <Table.Td className={styles.numeric}>{ruleNumber(rule.threshold)}</Table.Td>
                        <Table.Td className={styles.numeric}>
                          {humanDuration(rule.durationSeconds)}
                        </Table.Td>
                        <Table.Td className={styles.numeric}>
                          {humanDuration(rule.cooldownSeconds)}
                        </Table.Td>
                        <Table.Td className={styles.numeric}>{ruleNumber(rule.revision)}</Table.Td>
                        <Table.Td>{rule.enabled ? 'Enabled' : 'Disabled'}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}

          {selected && (
            <div className={styles.detail}>
              <Group justify="space-between" align="start">
                <div>
                  <h4>{selected.name}</h4>
                  <p className={styles.sentence}>
                    {ruleSentence(
                      selected,
                      conditions.find((entry) => entry.kind === selected.conditionKind)
                    )}
                  </p>
                </div>
                <Button size="compact-sm" variant="default" onClick={() => setEditing(selected)}>
                  Edit
                </Button>
              </Group>
              <Facts
                rows={[
                  ['Revision', ruleNumber(selected.revision)],
                  ['Created (UTC)', ruleTimestamp(selected.createdAt)],
                  ['Last changed (UTC)', ruleTimestamp(selected.updatedAt)],
                  ['Evidence source', selected.condition?.source || UNKNOWN],
                ]}
              />
              <DryRun rule={selected} conditions={conditions} />
            </div>
          )}

          <section className={styles.alerts} aria-label="Alert history">
            <h4>Alert history</h4>
            <p className={styles.note}>
              One open alert per rule and subject. Acknowledging closes it and lets a later breach
              alert again. Snoozing suppresses repetition and leaves the alert open.
            </p>
            {!events.length ? (
              <p className={styles.empty}>No alerts have been recorded.</p>
            ) : (
              <ScrollArea
                viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Scroll alerts' }}
              >
                <Table className={styles.table} aria-label="Recorded alerts">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Fired (UTC)</Table.Th>
                      <Table.Th>Rule</Table.Th>
                      <Table.Th>Subject</Table.Th>
                      <Table.Th>Measured</Table.Th>
                      <Table.Th>State</Table.Th>
                      <Table.Th>Evidence</Table.Th>
                      <Table.Th>Disposition</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {events.map((event) => (
                      <AlertRow
                        key={event.id}
                        event={event}
                        rules={rules}
                        conditions={conditions}
                        onChanged={resource.refresh}
                      />
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </section>

          {unavailable.length > 0 && (
            <section className={styles.unavailable} aria-label="Conditions not available">
              <h4>Conditions this build cannot offer</h4>
              <p className={styles.note}>
                These are listed rather than omitted, because a missing condition an operator
                expects is worse than a stated one.
              </p>
              <dl>
                {unavailable.map((entry) => (
                  <div key={entry.kind}>
                    <dt>{entry.label}</dt>
                    <dd>
                      {entry.reason}
                      <span className={styles.requires}>Would require: {entry.wouldRequire}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </section>
  );
}
