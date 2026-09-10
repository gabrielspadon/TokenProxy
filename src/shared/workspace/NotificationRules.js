'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Button,
  Loader,
  NumberInput,
  Select,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { CommitNumber, NameField } from './CommitFields';
import { InlineConfirm } from './InlineConfirm';
import { useResource } from './useResource';
import {
  ALERT_BUCKETS,
  ALERT_STATE_LABEL,
  DEFAULT_RULE,
  DRY_RUN_STATE_EXPLANATION,
  EVIDENCE_LABEL,
  RULE_BUCKETS,
  RULE_SORTS,
  UNKNOWN,
  alertState,
  alertSummary,
  evidenceHref,
  filterRules,
  humanDuration,
  ruleBucket,
  ruleNumber,
  ruleSentence,
  ruleStateWord,
  ruleSummary,
  ruleTimestamp,
  ruleWrite,
  scopeLabel,
  sortRules,
} from './notificationRulesModel';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  StateWord,
} from './Board';
import board from './board.module.css';
import styles from './notificationRules.module.css';
import { NotificationAutomation } from './NotificationAutomation';

const ENDPOINT = '/api/admin/notification-rules';
const TONE = Object.fromEntries(RULE_BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const ALERT_TONE = Object.fromEntries(ALERT_BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const SNOOZE = [
  { value: '1', label: '1 hour' },
  { value: '4', label: '4 hours' },
  { value: '24', label: '24 hours' },
];

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

// Label on the left, measurement on the right. A rule carries no percentage,
// so it gets the evidence line without the meter rather than an empty bar
// that would read as a measurement nobody took.
function FactLine({ label, value, note }) {
  return (
    <div className={styles.factLine}>
      <span>{label}</span>
      <span>{value}</span>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

// Everyday groups cards on the shared grid; Advanced groups dense rows in a
// block, so a row is not squeezed into a 250px card track.
function Group({ label, tone, count, advanced, children }) {
  if (!advanced)
    return (
      <BoardGroup label={label} tone={tone} count={count}>
        {children}
      </BoardGroup>
    );
  return (
    <section className={board.group} aria-label={`${label} ${count === 1 ? 'item' : 'items'}`}>
      <h3 className={board.groupTitle} data-tone={tone || undefined}>
        <i />
        {label}
        <span>{count}</span>
      </h3>
      <div className={board.rows}>{children}</div>
    </section>
  );
}

function RuleFields({ draft, conditions, condition, set, idPrefix }) {
  return (
    <>
      <TextInput
        size="xs"
        aria-label="Rule name"
        placeholder="Rule name"
        className={styles.addName}
        value={draft.name}
        maxLength={120}
        onChange={(event) => set({ name: event.currentTarget.value })}
      />
      <Select
        size="xs"
        aria-label="Condition"
        className={styles.addCondition}
        value={draft.conditionKind}
        allowDeselect={false}
        data={conditions.map((entry) => ({ value: entry.kind, label: entry.label }))}
        onChange={(value) => {
          const next = conditions.find((entry) => entry.kind === value);
          set({
            conditionKind: value,
            ...(next?.allowedScopes && !next.allowedScopes.includes(draft.scopeKind)
              ? { scopeKind: 'global', scopeId: null }
              : {}),
            threshold: next
              ? Math.min(Math.max(draft.threshold, next.thresholdRange[0]), next.thresholdRange[1])
              : draft.threshold,
          });
        }}
      />
      <Select
        size="xs"
        aria-label="Scope"
        className={styles.addScope}
        value={draft.scopeKind}
        allowDeselect={false}
        data={[
          { value: 'global', label: 'Every subject' },
          { value: 'connection', label: 'One account' },
          { value: 'provider', label: 'One provider' },
        ].filter((option) => !condition?.allowedScopes || condition.allowedScopes.includes(option.value))}
        onChange={(value) => set({ scopeKind: value })}
      />
      {draft.scopeKind !== 'global' ? (
        <TextInput
          size="xs"
          aria-label={draft.scopeKind === 'connection' ? 'Account id' : 'Provider'}
          placeholder={draft.scopeKind === 'connection' ? 'Account id' : 'Provider'}
          className={styles.addScopeId}
          classNames={{ input: styles.mono }}
          value={draft.scopeId || ''}
          onChange={(event) => set({ scopeId: event.currentTarget.value })}
        />
      ) : null}
      <NumberInput
        size="xs"
        hideControls
        aria-label={`Threshold${condition ? ` in ${condition.unit}` : ''}`}
        className={styles.addNumber}
        suffix={condition ? ` ${condition.unit}` : undefined}
        min={condition?.thresholdRange[0]}
        max={condition?.thresholdRange[1]}
        decimalScale={2}
        value={draft.threshold}
        onChange={(value) => set({ threshold: value })}
        id={`${idPrefix}-threshold`}
      />
      <NumberInput
        size="xs"
        hideControls
        aria-label={condition?.durationRole === 'window' ? 'Window in seconds' : 'Sustained for, in seconds'}
        className={styles.addNumber}
        suffix=" s"
        min={1}
        step={60}
        value={draft.durationSeconds}
        onChange={(value) => set({ durationSeconds: value })}
      />
      <NumberInput
        size="xs"
        hideControls
        aria-label="Cooldown in seconds"
        className={styles.addNumber}
        suffix=" s"
        min={60}
        step={60}
        value={draft.cooldownSeconds}
        onChange={(value) => set({ cooldownSeconds: value })}
      />
    </>
  );
}

// The inline add row. It sits between the toolbar and the groups, exactly
// where a new rule will appear, and closes itself once the save reads back.
function AddRuleRow({ conditions, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_RULE }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const condition = conditions.find((entry) => entry.kind === draft.conditionKind);
  const set = (patch) => setDraft((old) => ({ ...old, ...patch }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await send(ENDPOINT, 'POST', ruleWrite(draft));
      const readback = await send(`${ENDPOINT}/${saved.id}`, 'GET');
      onSaved(readback.rule, `Rule revision ${readback.rule.revision} saved and read back.`);
      onClose();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={board.addRow} onSubmit={submit} aria-label="Add a rule">
      <RuleFields draft={draft} conditions={conditions} condition={condition} set={set} idPrefix="new-rule" />
      <Switch
        size="xs"
        label="Enabled"
        checked={draft.enabled}
        onChange={(event) => set({ enabled: event.currentTarget.checked })}
      />
      <Button type="submit" size="xs" loading={busy} disabled={!draft.name.trim()}>
        Create rule
      </Button>
      <Button type="button" size="xs" variant="default" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      {condition ? <span className={board.addNote}>{ruleSentence(draft, condition)}</span> : null}
      {error ? (
        <Text size="xs" c="orange.8" role="alert" className={board.addNote}>
          {error}
        </Text>
      ) : null}
    </form>
  );
}

function RuleActions({ rule, busy, deleting, onEnabled, onDelete, onAskDelete, onCancelDelete }) {
  if (deleting)
    return (
      <InlineConfirm
        question={`Delete ${rule.name}?`}
        verb="Delete"
        danger
        busy={busy === 'delete'}
        onConfirm={onDelete}
        onCancel={onCancelDelete}
      />
    );
  return (
    <>
      <Tooltip label={rule.enabled ? 'Pause this rule' : 'Resume this rule'}>
        <ActionIcon
          variant={rule.enabled ? 'subtle' : 'light'}
          color={rule.enabled ? 'gray' : 'teal'}
          aria-label={`${rule.enabled ? 'Pause' : 'Resume'} ${rule.name}`}
          aria-pressed={!rule.enabled}
          loading={busy === 'enabled'}
          disabled={Boolean(busy) && busy !== 'enabled'}
          onClick={() => onEnabled(!rule.enabled)}
        >
          <Icon name={rule.enabled ? 'i-pause' : 'i-play'} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Delete this rule">
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Delete ${rule.name}`}
          disabled={Boolean(busy)}
          onClick={onAskDelete}
        >
          <Icon name="i-close" />
        </ActionIcon>
      </Tooltip>
    </>
  );
}

function RuleRow({ rule, condition, events, advanced, expanded, busy, deleting, detail, ...handlers }) {
  const bucket = ruleBucket(rule, events);
  const word = ruleStateWord(rule, events);
  const editable = !busy;
  return (
    <article className={board.row} data-rule-id={rule.id} data-expanded={expanded || undefined} data-bucket={bucket} aria-label={rule.name}>
      <div className={styles.ruleMain}>
        <Tooltip label={expanded ? 'Collapse' : 'Evidence'}>
          <button
            type="button"
            className={`${board.caret} ${styles.cell}`}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rule.name}`}
            onClick={handlers.onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </Tooltip>
        <div className={`${styles.cell} ${styles.identity}`}>
          <div className={board.identityText}>
            <NameField
              name={rule.name}
              label={`Rule name for ${rule.name}`}
              disabled={!editable}
              expanded={expanded}
              onOpen={handlers.onToggle}
              onCommit={(name) => handlers.onSave({ name }, 'Name')}
            />
            <small>
              {condition?.label || rule.conditionKind} · {scopeLabel(rule)}
            </small>
          </div>
        </div>
        <div className={`${styles.cell} ${styles.state}`}>
          <Tooltip label={ruleSentence(rule, condition)}>
            <span className={board.stateWord} data-tone={TONE[bucket]}>
              <i />
              {word}
            </span>
          </Tooltip>
        </div>
        {advanced ? (
          <Tooltip label={`Threshold in ${condition?.unit || 'the condition unit'}`}>
            <CommitNumber
              className={`${styles.field} ${styles.cell}`}
              aria-label={`Threshold for ${rule.name}`}
              value={rule.threshold}
              min={condition?.thresholdRange?.[0]}
              max={condition?.thresholdRange?.[1]}
              allowDecimal
              decimalScale={2}
              disabled={!editable}
              onCommit={(threshold) => handlers.onSave({ threshold }, 'Threshold')}
            />
          </Tooltip>
        ) : null}
        {advanced ? (
          <Tooltip label={condition?.durationRole === 'window' ? 'Window, in seconds' : 'Sustained for, in seconds'}>
            <CommitNumber
              className={`${styles.field} ${styles.cell}`}
              aria-label={`Duration in seconds for ${rule.name}`}
              value={rule.durationSeconds}
              min={1}
              allowDecimal={false}
              disabled={!editable}
              onCommit={(durationSeconds) => handlers.onSave({ durationSeconds }, 'Duration')}
            />
          </Tooltip>
        ) : null}
        {advanced ? (
          <Tooltip label="Cooldown between two alerts, in seconds">
            <CommitNumber
              className={`${styles.field} ${styles.cell}`}
              aria-label={`Cooldown in seconds for ${rule.name}`}
              value={rule.cooldownSeconds}
              min={60}
              allowDecimal={false}
              disabled={!editable}
              onCommit={(cooldownSeconds) => handlers.onSave({ cooldownSeconds }, 'Cooldown')}
            />
          </Tooltip>
        ) : null}
        <span className={`${board.muted} ${styles.cell}`}>rev {ruleNumber(rule.revision)}</span>
        <div className={`${styles.cell} ${styles.actions}`}>
          <RuleActions rule={rule} busy={busy} deleting={deleting} {...handlers} />
        </div>
      </div>
      {expanded && detail ? (
        <div className={board.detail} role="region" aria-label={`Evidence for ${rule.name}`}>
          {detail}
        </div>
      ) : null}
    </article>
  );
}

function RuleCard({ rule, condition, events, expanded, busy, deleting, detail, ...handlers }) {
  const bucket = ruleBucket(rule, events);
  return (
    <Card
      id={rule.id}
      bucket={bucket}
      expanded={expanded}
      label={rule.name}
      detail={detail}
      detailLabel={`Evidence for ${rule.name}`}
      head={
        <>
          <span className={styles.mark} aria-hidden="true">
            <Icon name="i-tune" />
          </span>
          <div className={board.identityText}>
            <NameField
              name={rule.name}
              label={`Rule name for ${rule.name}`}
              disabled={Boolean(busy)}
              expanded={expanded}
              onOpen={handlers.onToggle}
              onCommit={(name) => handlers.onSave({ name }, 'Name')}
            />
            <small>{condition?.label || rule.conditionKind}</small>
          </div>
          <Tooltip label={rule.enabled ? 'Pause this rule' : 'Resume this rule'}>
            <ActionIcon
              variant={rule.enabled ? 'subtle' : 'light'}
              color={rule.enabled ? 'gray' : 'teal'}
              aria-label={`${rule.enabled ? 'Pause' : 'Resume'} ${rule.name}`}
              aria-pressed={!rule.enabled}
              loading={busy === 'enabled'}
              disabled={Boolean(busy) && busy !== 'enabled'}
              onClick={() => handlers.onEnabled(!rule.enabled)}
            >
              <Icon name={rule.enabled ? 'i-pause' : 'i-play'} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={expanded ? 'Collapse' : 'Evidence'}>
            <button
              type="button"
              className={board.caret}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rule.name}`}
              onClick={handlers.onToggle}
            >
              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
            </button>
          </Tooltip>
        </>
      }
      state={
        <>
          <StateWord tone={TONE[bucket]}>{ruleStateWord(rule, events)}</StateWord>
          <span className={board.spacer} />
          <span className={board.cardAttempts}>{scopeLabel(rule)}</span>
        </>
      }
    >
      <FactLine
        label="Threshold"
        value={`${ruleNumber(rule.threshold)} ${condition?.unit || ''}`.trim()}
      />
      <FactLine
        label={condition?.durationRole === 'window' ? 'Within' : 'Sustained'}
        value={humanDuration(rule.durationSeconds)}
      />
      <FactLine label="Cooldown" value={humanDuration(rule.cooldownSeconds)} />
      {deleting ? (
        <InlineConfirm
          question={`Delete ${rule.name}?`}
          verb="Delete"
          danger
          busy={busy === 'delete'}
          onConfirm={handlers.onDelete}
          onCancel={handlers.onCancelDelete}
        />
      ) : (
        <span className={styles.cardActions}>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={handlers.onAskDelete} disabled={Boolean(busy)}>
            Delete rule
          </Button>
        </span>
      )}
    </Card>
  );
}

function DryRun({ rule, conditions }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const condition = conditions.find((entry) => entry.kind === rule.conditionKind);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if ((start && !end) || (!start && end) || (start && Date.parse(`${start}Z`) >= Date.parse(`${end}Z`))) {
        throw new Error(
          'Choose both UTC bounds with the start before the end, or leave both empty for the retained default range.'
        );
      }
      setResult(
        await send(`${ENDPOINT}/dry-run`, 'POST', {
          rule,
          ...(start
            ? { start: new Date(`${start}Z`).toISOString(), end: new Date(`${end}Z`).toISOString() }
            : {}),
        })
      );
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.dryRun} aria-label="Rule dry run">
      <div className={styles.dryRunHead}>
        <h4>Dry run against retained history</h4>
        <span className={board.spacer} />
        <TextInput
          size="xs"
          type="datetime-local"
          aria-label="Range start (UTC)"
          value={start}
          onChange={(event) => setStart(event.currentTarget.value)}
        />
        <TextInput
          size="xs"
          type="datetime-local"
          aria-label="Range end (UTC)"
          value={end}
          onChange={(event) => setEnd(event.currentTarget.value)}
        />
        <Button size="xs" variant="default" onClick={run} loading={busy}>
          Run against history
        </Button>
      </div>
      <p className={styles.note}>
        Replays this rule over the records this installation still retains and lists what it would
        have alerted on. Nothing is sent, nothing is stored, and no account or route is touched.
        Periods with no retained evidence cannot be evaluated and are reported as such.
      </p>
      {error ? (
        <Alert color="orange" title="Dry run unavailable">
          {error}
        </Alert>
      ) : null}
      {result ? (
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
              {ruleNumber(result.total)} records match this scope, above the {ruleNumber(result.limit)} row
              ceiling for one evaluation. Narrow the range; no partial verdict is calculated.
            </Alert>
          ) : result.evidenceAbsent ? (
            <p className={styles.empty}>
              No records of this kind were retained for this scope in the range. This is an absence of
              evidence, not evidence that the condition never held.
            </p>
          ) : (
            <div className={styles.dryRunGroups}>
              {result.groups.map((group) => (
                <div key={group.scopeKey} className={styles.dryRunGroup}>
                  <code title={group.scopeKey}>{group.scopeKey}</code>
                  <FactLine label="Records" value={ruleNumber(group.sampleCount)} />
                  <FactLine label="Measured" value={ruleNumber(group.measuredCount)} />
                  <FactLine label="Would alert" value={ruleNumber(group.firings.length)} />
                  <p className={styles.note}>
                    {group.firings.length
                      ? `First firing ${ruleTimestamp(group.firings[0].firedAt)} UTC`
                      : DRY_RUN_STATE_EXPLANATION[group.state] || UNKNOWN}
                  </p>
                </div>
              ))}
            </div>
          )}
          {result.groups.some((group) => group.firings.length > 0) ? (
            <details className={styles.firings}>
              <summary>
                {ruleNumber(result.firingCount)} historical firings and their triggering records
              </summary>
              <ul>
                {result.groups.flatMap((group) =>
                  group.firings.map((firing) => (
                    <li key={`${group.scopeKey}:${firing.firedAt}`}>
                      <code>{group.scopeKey}</code> at {ruleTimestamp(firing.firedAt)} UTC, breach from{' '}
                      {ruleTimestamp(firing.breachStartedAt)}, measured {ruleNumber(firing.observedValue)}{' '}
                      {condition?.unit || ''} across {ruleNumber(firing.sampleCount)}{' '}
                      {EVIDENCE_LABEL[condition?.evidenceKind] || 'record'}
                      {firing.sampleCount === 1 ? '' : 's'}.{' '}
                      {(firing.refs || []).map((ref, index) => {
                        const href = evidenceHref(condition?.evidenceKind, ref, { scopeKey: group.scopeKey });
                        return href ? (
                          <Link key={ref} href={href}>
                            Inspect evidence {index + 1}
                          </Link>
                        ) : (
                          <code key={ref}>{ref}</code>
                        );
                      })}
                    </li>
                  ))
                )}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RuleDetail({ rule, conditions }) {
  const audit = useResource(`${ENDPOINT}/${rule.id}`, { interval: 0 });
  const condition = conditions.find((entry) => entry.kind === rule.conditionKind);
  return (
    <div className={styles.detail}>
      <p className={styles.sentence}>{ruleSentence(rule, condition)}</p>
      <Facts
        rows={[
          ['Revision', ruleNumber(rule.revision)],
          ['Created (UTC)', ruleTimestamp(rule.createdAt)],
          ['Last changed (UTC)', ruleTimestamp(rule.updatedAt)],
          ['Evidence source', rule.condition?.source || condition?.source || UNKNOWN],
        ]}
      />
      <NotificationAutomation rule={rule} />
      <DryRun key={`${rule.id}:${rule.revision}`} rule={rule} conditions={conditions} />
      <section aria-label="Rule revision audit">
        <div className={styles.dryRunHead}>
          <h4>Retained revisions</h4>
          <span className={board.spacer} />
          <Button size="xs" variant="subtle" onClick={audit.refresh}>
            Refresh audit
          </Button>
        </div>
        {audit.error ? (
          <Alert color="orange" title="Audit unavailable">
            {audit.error}
          </Alert>
        ) : audit.loading ? (
          <Loader size="xs" />
        ) : (
          <ol className={styles.audit}>
            {(audit.data?.versions || []).map((version) => (
              <li key={version.revision}>
                <strong>
                  Revision {version.revision}, {version.change}
                </strong>{' '}
                · {ruleTimestamp(version.changedAt)} UTC
                <p>
                  {scopeLabel(version.definition)}.{' '}
                  {ruleSentence(
                    version.definition,
                    conditions.find((entry) => entry.kind === version.definition.conditionKind)
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function AlertItem({ event, condition, rule, advanced, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [snoozeHours, setSnoozeHours] = useState('24');
  const state = alertState(event);
  const refs = event.evidence?.refs || [];
  const href = evidenceHref(event.evidence?.kind, refs[0], event);
  const act = async (body) => {
    setBusy(true);
    setFeedback(null);
    try {
      const receipt = await send(`${ENDPOINT}/events/${event.id}`, 'POST', body);
      const readback = await send(ENDPOINT, 'GET');
      const stored = readback.events?.find((entry) => entry.id === event.id);
      if (!stored || stored.outcome !== receipt.outcome || stored.snoozedUntil !== receipt.snoozedUntil) {
        throw new Error(
          'The action returned but its retained state could not be verified. Refresh before another action.'
        );
      }
      setFeedback({
        ok: true,
        text:
          body.action === 'acknowledge'
            ? `Acknowledged at ${ruleTimestamp(stored.acknowledgedAt)} UTC.`
            : `Snooze retained until ${ruleTimestamp(stored.snoozedUntil)} UTC.`,
      });
      onChanged();
    } catch (caught) {
      setFeedback({ ok: false, text: `${caught.message} No automatic retry was sent.` });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const name = rule?.name || 'Rule deleted';
  const evidence = refs.length ? (
    href ? (
      <Link href={href}>
        {ruleNumber(refs.length)} {EVIDENCE_LABEL[event.evidence.kind] || 'record'}
        {refs.length === 1 ? '' : 's'}
      </Link>
    ) : (
      `${ruleNumber(refs.length)} ${EVIDENCE_LABEL[event.evidence.kind] || 'records'}`
    )
  ) : (
    UNKNOWN
  );
  const controls =
    event.outcome === 'firing' ? (
      <>
        <Button
          size="compact-xs"
          variant="default"
          disabled={busy}
          aria-label={`Acknowledge alert on ${event.scopeKey}`}
          onClick={() => act({ action: 'acknowledge' })}
        >
          Acknowledge
        </Button>
        <Select
          size="xs"
          aria-label={`Snooze duration for ${event.scopeKey}`}
          className={styles.snooze}
          value={snoozeHours}
          onChange={setSnoozeHours}
          allowDeselect={false}
          data={SNOOZE}
          disabled={busy}
        />
        <Button
          size="compact-xs"
          variant="default"
          disabled={busy}
          aria-label={`Snooze alert on ${event.scopeKey} for ${snoozeHours} hours`}
          onClick={() =>
            act({
              action: 'snooze',
              until: new Date(Date.now() + Number(snoozeHours) * 3_600_000).toISOString(),
            })
          }
        >
          Snooze
        </Button>
      </>
    ) : null;

  if (advanced)
    return (
      <article className={board.row} data-state={state} aria-label={`Alert on ${event.scopeKey}`}>
        <div className={styles.alertMain}>
          <div className={`${styles.cell} ${board.identityText}`}>
            <strong>{name}</strong>
            <small>
              <code>{event.scopeKey}</code>
            </small>
          </div>
          <span className={styles.cell}>
            <StateWord tone={ALERT_TONE[state]}>{ALERT_STATE_LABEL[state]}</StateWord>
          </span>
          <span className={`${board.muted} ${styles.cell}`}>{ruleTimestamp(event.firedAt)}</span>
          <span className={`${styles.measured} ${styles.cell}`}>
            {ruleNumber(event.observedValue)}
            {condition ? ` ${condition.unit}` : ''}
          </span>
          <span className={`${board.muted} ${styles.cell}`}>{evidence}</span>
          <div className={`${styles.cell} ${styles.actions}`}>{controls}</div>
        </div>
        {feedback ? (
          <p className={styles.note} role={feedback.ok ? 'status' : 'alert'}>
            {feedback.text}
          </p>
        ) : null}
      </article>
    );

  return (
    <Card
      id={event.id}
      bucket={state}
      label={`Alert on ${event.scopeKey}`}
      head={
        <>
          <span className={styles.mark} aria-hidden="true">
            <Icon name="i-warning" />
          </span>
          <div className={board.identityText}>
            <strong>{name}</strong>
            <small>
              <code>{event.scopeKey}</code>
            </small>
          </div>
        </>
      }
      state={
        <>
          <StateWord tone={ALERT_TONE[state]}>{ALERT_STATE_LABEL[state]}</StateWord>
          <span className={board.spacer} />
          <span className={board.cardAttempts}>{ruleTimestamp(event.firedAt)}</span>
        </>
      }
    >
      <FactLine
        label="Measured"
        value={`${ruleNumber(event.observedValue)}${condition ? ` ${condition.unit}` : ''}`}
      />
      <FactLine label="Evidence" value={evidence} />
      {state === 'snoozed' ? (
        <FactLine label="Snoozed until" value={ruleTimestamp(event.snoozedUntil)} />
      ) : null}
      {event.acknowledgedAt ? (
        <FactLine label="Acknowledged" value={`${ruleTimestamp(event.acknowledgedAt)} UTC`} />
      ) : null}
      {controls ? <span className={styles.cardActions}>{controls}</span> : null}
      {feedback ? (
        <p className={styles.note} role={feedback.ok ? 'status' : 'alert'}>
          {feedback.text}
        </p>
      ) : null}
    </Card>
  );
}

export function NotificationRules({
  selectedEventId = null,
  advanced = false,
  density = 'tidy',
  onDensity,
}) {
  const resource = useResource(ENDPOINT);
  const selectedEvent = useResource(
    selectedEventId ? `${ENDPOINT}/events/${encodeURIComponent(selectedEventId)}` : null
  );
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [kind, setKind] = useState(null);
  const [sort, setSort] = useState('state');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [busy, setBusy] = useState({});
  const [receipt, setReceipt] = useState(null);
  const rules = useMemo(() => resource.data?.rules || [], [resource.data]);
  const conditions = useMemo(() => resource.data?.conditions || [], [resource.data]);
  const events = useMemo(() => resource.data?.events || [], [resource.data]);
  const unavailable = resource.data?.unavailableConditions || [];
  const summary = ruleSummary(rules, events);
  const alerts = alertSummary(events);
  const visible = sortRules(filterRules(rules, { query, bucket, kind }, { conditions, events }), sort, events);
  const kinds = useMemo(
    () => [...new Set(rules.map((rule) => rule.conditionKind))],
    [rules]
  );
  const { refresh } = resource;
  const conditionOf = useCallback(
    (rule) => conditions.find((entry) => entry.kind === rule.conditionKind),
    [conditions]
  );

  async function mutate(id, work, run) {
    if (busy[id]) return;
    setBusy((previous) => ({ ...previous, [id]: work }));
    try {
      const message = await run();
      if (message) setReceipt({ ok: true, text: message });
    } catch (error) {
      setReceipt({ ok: false, text: `${error.message} No automatic retry was sent.` });
    } finally {
      setBusy((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      refresh();
    }
  }

  // Every edit reads the stored rule first, writes the whole definition with
  // that revision as the baseline, then reads back. A competing write shows as
  // a conflict rather than being overwritten.
  const save = (rule, patch, label) =>
    mutate(rule.id, patch.enabled === undefined ? 'save' : 'enabled', async () => {
      const current = await send(`${ENDPOINT}/${rule.id}`, 'GET');
      const saved = await send(`${ENDPOINT}/${rule.id}`, 'PUT', ruleWrite(current.rule, patch));
      const readback = await send(`${ENDPOINT}/${saved.id}`, 'GET');
      if (readback.rule?.revision !== saved.revision)
        throw new Error('The save returned, but the stored revision changed before readback.');
      return `${label} saved at revision ${readback.rule.revision}.`;
    });

  const remove = (rule) =>
    mutate(rule.id, 'delete', async () => {
      const current = await send(`${ENDPOINT}/${rule.id}`, 'GET');
      await send(`${ENDPOINT}/${rule.id}?revision=${current.rule.revision}`, 'DELETE');
      setDeletingId(null);
      setOpenId((open) => (open === rule.id ? null : open));
      return `${rule.name} deleted.`;
    });

  const chips = [
    { id: null, label: 'rules', count: rules.length },
    ...RULE_BUCKETS.map((item) => ({
      id: item.id,
      tone: item.tone,
      label: item.label.toLowerCase(),
      count: summary[item.id],
    })),
  ];

  const handlers = (rule) => ({
    onToggle: () => setOpenId((open) => (open === rule.id ? null : rule.id)),
    onSave: (patch, label) => save(rule, patch, label),
    onEnabled: (enabled) => save(rule, { enabled }, enabled ? 'Resume' : 'Pause'),
    onAskDelete: () => setDeletingId(rule.id),
    onCancelDelete: () => setDeletingId(null),
    onDelete: () => remove(rule),
  });

  return (
    <Board label="Notification rules" advanced={advanced} density={density}>
      <BoardSummary
        label="Rule summary"
        chips={chips}
        active={bucket}
        onPick={(id) => setBucket(id === bucket ? null : id)}
        note={
          resource.loading && !rules.length
            ? 'Reading rules…'
            : advanced
              ? 'Edits save on Enter or blur'
              : `${alerts.firing} open ${alerts.firing === 1 ? 'alert' : 'alerts'} · Advanced adds threshold, duration and cooldown`
        }
      />
      <BoardToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search rules"
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Icon name="i-add" />}
              aria-expanded={adding}
              disabled={!conditions.length}
              onClick={() => setAdding((previous) => !previous)}
            >
              Add rule
            </Button>
            <Tooltip label="Re-read rules, alerts and conditions">
              <ActionIcon variant="default" aria-label="Refresh rules" loading={resource.loading} onClick={refresh}>
                <Icon name="i-refresh" />
              </ActionIcon>
            </Tooltip>
          </>
        }
      >
        {kinds.length > 1 ? (
          <div className={styles.kinds} role="group" aria-label="Condition filter">
            {kinds.map((entry) => {
              const label = conditions.find((item) => item.kind === entry)?.label || entry;
              return (
                <button
                  key={entry}
                  type="button"
                  className={board.fleetChip}
                  aria-pressed={kind === entry}
                  onClick={() => setKind(kind === entry ? null : entry)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        {advanced ? (
          <Select
            size="xs"
            aria-label="Sort rules"
            data={RULE_SORTS}
            value={sort}
            onChange={(value) => value && setSort(value)}
            leftSection={<Icon name="i-sort" />}
            className={board.sort}
            allowDeselect={false}
          />
        ) : null}
        <Tooltip label="How much room each rule takes">
          <DensitySwitch value={density} onChange={onDensity} />
        </Tooltip>
      </BoardToolbar>
      {adding ? (
        <AddRuleRow
          conditions={conditions}
          onClose={() => setAdding(false)}
          onSaved={(rule, message) => {
            setReceipt({ ok: true, text: message });
            setOpenId(rule.id);
            refresh();
          }}
        />
      ) : null}
      {receipt ? (
        <p className={board.notice} role={receipt.ok ? 'status' : 'alert'}>
          {receipt.text}
        </p>
      ) : null}
      {resource.error ? (
        <Text size="xs" c="orange.8" role="alert" className={board.notice}>
          Notification rules unavailable. {resource.error}
        </Text>
      ) : null}
      {selectedEventId ? (
        <section id="selected-alert" className={board.notice} aria-label="Selected triggering alert">
          {selectedEvent.loading ? <Loader size="xs" /> : null}
          {selectedEvent.error ? <Alert color="orange">{selectedEvent.error}</Alert> : null}
          {selectedEvent.data?.event ? (
            <Facts
              rows={[
                ['Alert', selectedEvent.data.event.id],
                ['Rule', selectedEvent.data.event.ruleDefinition?.name || UNKNOWN],
                ['Fired (UTC)', ruleTimestamp(selectedEvent.data.event.firedAt)],
                ['Account or scope', selectedEvent.data.event.scopeKey],
                ['State', alertState(selectedEvent.data.event)],
                ['Observed value', ruleNumber(selectedEvent.data.event.observedValue)],
              ]}
            />
          ) : null}
        </section>
      ) : null}
      {RULE_BUCKETS.map((item) => {
        const members = visible.filter((rule) => ruleBucket(rule, events) === item.id);
        if (!members.length) return null;
        return (
          <Group key={item.id} label={item.label} tone={item.tone} count={members.length} advanced={advanced}>
            {members.map((rule) => {
              const props = {
                rule,
                condition: conditionOf(rule),
                events,
                expanded: openId === rule.id,
                busy: busy[rule.id],
                deleting: deletingId === rule.id,
                detail: openId === rule.id ? <RuleDetail rule={rule} conditions={conditions} /> : null,
                ...handlers(rule),
              };
              return advanced ? (
                <RuleRow key={rule.id} advanced {...props} />
              ) : (
                <RuleCard key={rule.id} {...props} />
              );
            })}
          </Group>
        );
      })}
      {events.length ? (
        <Group label="Alerts" tone={alerts.firing ? 'refusal' : null} count={events.length} advanced={advanced}>
          {events.map((event) => (
            <AlertItem
              key={event.id}
              event={event}
              advanced={advanced}
              rule={
                event.ruleDefinition ||
                rules.find((entry) => entry.id === event.ruleId && entry.revision === event.ruleRevision) ||
                rules.find((entry) => entry.id === event.ruleId)
              }
              condition={conditions.find(
                (entry) =>
                  entry.kind ===
                  (event.ruleDefinition?.conditionKind ||
                    rules.find((rule) => rule.id === event.ruleId)?.conditionKind)
              )}
              onChanged={refresh}
            />
          ))}
        </Group>
      ) : null}
      {unavailable.length ? (
        <BoardGroup label="Conditions this build cannot offer" count={unavailable.length}>
          {unavailable.map((entry) => (
            <Card key={entry.kind} id={entry.kind} label={entry.label} head={<strong>{entry.label}</strong>}>
              <p className={styles.note}>
                {entry.reason} Would require: {entry.wouldRequire}
              </p>
            </Card>
          ))}
        </BoardGroup>
      ) : null}
      <div className={board.messages}>
        {resource.loading && !rules.length ? (
          <div className={board.empty}>
            <Loader size="xs" /> Reading rules…
          </div>
        ) : null}
        {!rules.length && !resource.loading && !resource.error ? (
          <div className={board.empty}>
            No rules are defined. Add one above; it alerts on evidence this installation already
            retains and cannot reconstruct history it never recorded.
          </div>
        ) : null}
        {rules.length && !visible.length ? (
          <div className={board.empty}>
            No rule matches.{' '}
            <button
              type="button"
              className={board.linkButton}
              onClick={() => {
                setQuery('');
                setBucket(null);
                setKind(null);
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </Board>
  );
}
