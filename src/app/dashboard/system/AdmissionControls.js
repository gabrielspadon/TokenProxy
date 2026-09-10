'use client';
import { useState } from 'react';
import { Button, Select } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { Card, StateWord } from '@/shared/workspace/Board';
import { Icon } from '@/shared/components/Icon';
import board from '@/shared/workspace/board.module.css';
import { CommitNumber } from '@/shared/workspace/CommitFields';
import { FactLine, SettingRow } from './SettingRow';
import styles from './system.module.css';

const STREAM_LABELS = {
  minStreams: 'Minimum streams',
  maxStreams: 'Maximum streams',
  clientStreams: 'Streams per client',
};
const LIMIT_LABELS = {
  maxHandlers: 'Maximum handlers',
  clientHandlers: 'Handlers per client',
  providerStreams: 'Streams per provider',
  queueDepth: 'Queue capacity',
  clientQueueDepth: 'Queue per client',
  maxWaitMs: 'Maximum wait (ms)',
  memoryBudgetMb: 'Memory budget (MiB)',
  eventLoopBudgetMs: 'Event loop budget (ms)',
  minSamples: 'Minimum samples',
  cooldownMs: 'Adjustment cooldown (ms)',
};

// Request capacity is a settings card: every control saves the whole policy on
// change, and the receipt says which revision the gateway read back.
export default function AdmissionControls({ advanced, expanded, onToggle }) {
  const read = usePoll('/api/system/admission', 5000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const data = read.data;
  const policy = data?.policy;

  async function save(patch) {
    if (!policy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/system/admission', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...policy, ...patch }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Admission policy could not be saved');
      setMessage({ ok: true, text: 'Admission policy saved and read back.' });
      read.refresh();
    } catch (error) {
      setMessage({ ok: false, text: `${error.message} Nothing was retried automatically.` });
    } finally {
      setBusy(false);
    }
  }

  const mode = !policy
    ? null
    : policy.overrideStreams !== null
      ? 'override'
      : policy.adaptive
        ? 'adaptive'
        : 'fixed';
  const numbers = advanced ? { ...STREAM_LABELS, ...LIMIT_LABELS } : STREAM_LABELS;

  return (
    <Card
      id="admission"
      label="Request capacity"
      expanded={expanded}
      head={
        <>
          <span className={styles.mark} aria-hidden="true">
            <Icon name="i-request" />
          </span>
          <div className={board.identityText}>
            <strong>Request capacity</strong>
            <small>
              Limits apply to this process; existing streams finish when a limit decreases
            </small>
          </div>
          <button
            type="button"
            className={board.caret}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} request capacity`}
            onClick={onToggle}
          >
            <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
          </button>
        </>
      }
      state={
        data ? (
          <>
            <StateWord tone={data.queued > 0 ? 'ember' : 'positive'}>
              {data.decision.replaceAll('-', ' ')}
            </StateWord>
            <span className={board.spacer} />
            <span className={board.cardAttempts}>
              {data.activeStreams} / {data.effectiveStreams} streams
            </span>
          </>
        ) : null
      }
      detail={
        expanded && policy ? (
          <div className={styles.settings}>
            <SettingRow
              label="Capacity mode"
              control={
                <Select
                  size="xs"
                  aria-label="Capacity mode"
                  allowDeselect={false}
                  className={styles.select}
                  data={[
                    { value: 'adaptive', label: 'Adaptive' },
                    { value: 'fixed', label: 'Fixed maximum' },
                    { value: 'override', label: 'Temporary override' },
                  ]}
                  value={mode}
                  disabled={busy}
                  onChange={(next) =>
                    next &&
                    save({
                      adaptive: next !== 'fixed',
                      overrideStreams: next === 'override' ? policy.minStreams : null,
                    })
                  }
                />
              }
              state={
                mode === 'override'
                  ? 'Override in force'
                  : mode === 'adaptive'
                    ? 'Adaptive'
                    : 'Fixed'
              }
            />
            {Object.entries(numbers).map(([key, label]) => (
              <SettingRow
                key={key}
                label={label}
                control={
                  <CommitNumber
                    className={styles.number}
                    aria-label={label}
                    value={policy[key]}
                    min={1}
                    max={key.endsWith('Streams') || key === 'maxStreams' ? 65536 : undefined}
                    disabled={busy}
                    onCommit={(value) => save({ [key]: value })}
                  />
                }
              />
            ))}
            {policy.overrideStreams !== null ? (
              <SettingRow
                label="Override streams"
                control={
                  <CommitNumber
                    className={styles.number}
                    aria-label="Override streams"
                    value={policy.overrideStreams}
                    min={policy.minStreams}
                    max={policy.maxStreams}
                    disabled={busy}
                    onCommit={(value) => save({ overrideStreams: value })}
                  />
                }
              />
            ) : null}
            <p className={styles.aside}>
              Each client can use at most half the effective stream capacity so another client can
              enter. Account capacity and quota eligibility still apply. Connection pool pressure is
              unavailable.
              {advanced ? '' : ' Advanced adds the handler, provider and pressure limits.'}
            </p>
          </div>
        ) : null
      }
    >
      {read.error ? (
        <p className={styles.deny} role="alert">
          Capacity could not be refreshed.{' '}
          <button type="button" className={board.linkButton} onClick={read.refresh}>
            Retry capacity
          </button>
        </p>
      ) : null}
      {data ? (
        <>
          <FactLine
            label="Active streams"
            value={`${data.activeStreams} / ${data.effectiveStreams}`}
          />
          <FactLine
            label="Handlers"
            value={`${data.activeHandlers} / ${data.policy.maxHandlers}`}
          />
          <FactLine label="Waiting" value={data.queued} />
          <FactLine label="Oldest wait" value={`${Math.round(data.oldestQueueMs)} ms`} />
        </>
      ) : (
        <p className={styles.aside}>Reading request capacity…</p>
      )}
      {message ? (
        <p
          className={message.ok ? styles.aside : styles.deny}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}
      {!expanded ? (
        <span className={styles.actions}>
          <Button size="compact-xs" variant="default" onClick={onToggle}>
            Change limits
          </Button>
        </span>
      ) : null}
    </Card>
  );
}
