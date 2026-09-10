'use client';
import { useState } from 'react';
import { Select } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { StateWord } from '@/shared/workspace/Board';
import { CommitNumber } from '@/shared/workspace/CommitFields';
import { Row } from './Row';
import styles from './system.module.css';

const STREAMS = {
  minStreams: ['Minimum streams', 'The floor adaptive capacity never goes under'],
  maxStreams: ['Maximum streams', 'The ceiling for every mode, 1 through 65536'],
  clientStreams: ['Streams per client', 'One client never holds more than this'],
};
const LIMITS = {
  maxHandlers: ['Maximum handlers', 'Requests in any phase, streaming or not'],
  clientHandlers: ['Handlers per client', 'One client never holds more than this'],
  providerStreams: ['Streams per provider', 'Concurrent streams against one upstream'],
  queueDepth: ['Queue capacity', 'Requests held when every stream is busy'],
  clientQueueDepth: ['Queue per client', 'One client never queues more than this'],
  maxWaitMs: ['Maximum wait', 'Milliseconds queued before a request is refused'],
  memoryBudgetMb: ['Memory budget', 'Mebibytes of heap adaptive capacity protects'],
  eventLoopBudgetMs: ['Event loop budget', 'Milliseconds of lag adaptive capacity tolerates'],
  minSamples: ['Minimum samples', 'Readings before adaptive capacity adjusts'],
  cooldownMs: ['Adjustment cooldown', 'Milliseconds between adaptive adjustments'],
};
const UNITS = {
  maxWaitMs: ' ms',
  memoryBudgetMb: ' MiB',
  eventLoopBudgetMs: ' ms',
  cooldownMs: ' ms',
};
const MODES = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'fixed', label: 'Fixed maximum' },
  { value: 'override', label: 'Temporary override' },
];

// Request capacity is one group of rows on the control panel. Every control
// saves the whole policy on change, and the receipt says the gateway read it
// back. Everyday shows the mode and the stream counts; Advanced adds the
// handler, provider and pressure limits.
export default function AdmissionControls({ advanced }) {
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
  const numbers = advanced ? { ...STREAMS, ...LIMITS } : STREAMS;
  const override = policy?.overrideStreams !== null && policy?.overrideStreams !== undefined;
  const count = 2 + Object.keys(numbers).length + (override ? 1 : 0);
  const live = data
    ? [
        `${data.activeStreams} / ${data.effectiveStreams} streams`,
        `${data.activeHandlers} / ${data.policy.maxHandlers} handlers`,
        data.queued
          ? `${data.queued} waiting, oldest ${Math.round(data.oldestQueueMs)} ms`
          : 'none waiting',
      ].join(', ')
    : read.error
      ? 'Capacity could not be read.'
      : 'Reading…';

  return (
    <section
      className={styles.group}
      aria-label="Request capacity settings"
      data-tone={data ? (data.queued > 0 ? 'ember' : 'positive') : undefined}
    >
      <h3 className={styles.groupTitle}>
        <i />
        Request capacity
        <span>{count}</span>
      </h3>
      <div className={styles.rows}>
        <Row
          id="admission"
          label="Live"
          hint="Limits apply to this process; existing streams finish when a limit decreases"
          control={
            <span className={styles.reading}>
              {live}
              {read.error ? (
                <>
                  {' '}
                  <button type="button" className={styles.linkButton} onClick={read.refresh}>
                    Read again
                  </button>
                </>
              ) : null}
            </span>
          }
          state={
            data ? (
              <StateWord tone={data.queued > 0 ? 'ember' : 'positive'}>
                {data.decision.replaceAll('-', ' ')}
              </StateWord>
            ) : null
          }
        />
        <Row
          id="admission-mode"
          label="Capacity mode"
          hint="Adaptive follows pressure, fixed holds the maximum, override pins a count for now"
          control={
            <Select
              size="xs"
              aria-label="Capacity mode"
              allowDeselect={false}
              className={styles.select}
              data={MODES}
              value={mode}
              disabled={busy || !policy}
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
            mode ? (
              <StateWord tone={mode === 'override' ? 'ember' : null}>
                {mode === 'override'
                  ? 'Override in force'
                  : mode === 'adaptive'
                    ? 'Adaptive'
                    : 'Fixed'}
              </StateWord>
            ) : null
          }
        />
        {override ? (
          <Row
            id="admission-override"
            label="Override streams"
            hint={`Pinned between ${policy.minStreams} and ${policy.maxStreams} until the mode changes`}
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
            state={null}
          />
        ) : null}
        {Object.entries(numbers).map(([key, [label, hint]]) => (
          <Row
            key={key}
            id={`admission-${key}`}
            label={label}
            hint={hint}
            control={
              <CommitNumber
                className={styles.number}
                aria-label={label}
                value={policy?.[key] ?? 0}
                min={1}
                max={key.endsWith('Streams') ? 65536 : undefined}
                suffix={UNITS[key]}
                disabled={busy || !policy}
                onCommit={(value) => save({ [key]: value })}
              />
            }
            state={null}
          />
        ))}
      </div>
      <p className={styles.aside}>
        Each client can use at most half the effective stream capacity so another client can enter.
        Account capacity and quota eligibility still apply. Connection pool pressure is unavailable.
        {advanced ? '' : ' Advanced adds the handler, provider and pressure limits.'}
      </p>
      {message ? (
        <p
          className={styles.outcome}
          data-tone={message.ok ? 'ok' : 'bad'}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
