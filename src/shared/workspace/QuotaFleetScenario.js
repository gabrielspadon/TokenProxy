'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, MultiSelect, NumberInput, Select, TextInput } from '@mantine/core';
import { quotaNumber, quotaTimestamp } from './quotaWorkbenchModel';
import styles from './quotaHistoryWorkbench.module.css';

const INITIAL = { model: '', sessionHash: '', multiplier: 1, hours: 24, excludedConnectionIds: [], preferredConnectionId: '' };
const stateLabel = projection => projection.deadlineBeforeAsOf ? `Projected deadline already passed ${quotaTimestamp(projection.exhaustionAt)} UTC` : projection.exhaustionAt ? `${quotaTimestamp(projection.exhaustionAt)} UTC`
  : projection.state === 'reset_before_exhaustion' ? 'reset bounds forecast' : projection.state.replaceAll('_', ' ');

export function QuotaFleetScenario({ analysisUrl, model = '', retentionKey = analysisUrl }) {
  const storageKey = `quota-fleet-v1:${retentionKey}`;
  const [controls, setControls] = useState({ ...INITIAL, model });
  const [saved, setSaved] = useState(null), [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const controller = useRef(null);
  useEffect(() => {
    // Restoring a capture never contacts a provider or recaptures live state.
    let restored, active = true;
    try { restored = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Browser storage can be unavailable. */ }
    queueMicrotask(() => {
      if (active && restored?.capture && restored?.controls) { setSaved(restored); setControls(restored.controls); setResult(restored.result?.retainedPeriod ? restored.result : null); }
    });
    return () => { active = false; controller.current?.abort(); };
  }, [storageKey]);
  const update = (key, value) => { controller.current?.abort(); setBusy(false); setControls(current => ({ ...current, [key]: value })); setResult(null); };
  const run = async recapture => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null); setResult(null);
    try {
      const range = new URL(analysisUrl, location.origin).searchParams;
      const input = { model: controls.model };
      const scenario = { multiplier: controls.multiplier, hours: controls.hours, excludedConnectionIds: controls.excludedConnectionIds,
        ...(controls.preferredConnectionId ? { preferredConnectionId: controls.preferredConnectionId } : {}) };
      const send = async body => {
        const response = await fetch('/api/admin/quota/scenario', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Fleet scenario failed.');
        return data;
      };
      const captured = recapture || !saved ? await send({ operation: 'capture', input, ...(controls.sessionHash ? { sessionHash: controls.sessionHash } : {}),
        start: range.get('start'), end: range.get('end') }) : saved;
      const comparison = await send({ operation: 'compare', capture: captured.capture, input: captured.input, scenario });
      if (abort.signal.aborted) return;
      const retained = { capture: captured.capture, input: captured.input, controls, result: comparison };
      setSaved(retained); setResult(comparison);
      try { sessionStorage.setItem(storageKey, JSON.stringify(retained)); } catch { setError('Comparison completed. Browser storage is unavailable; reload will lose this capture.'); }
    } catch (failure) { if (!abort.signal.aborted) setError(failure.message); }
    finally { if (controller.current === abort) setBusy(false); }
  };
  const options = saved?.capture.routing.accounts.map(account => ({ value: account.id, label: account.id })) ?? [];
  const captureChanged = saved && (saved.input.model !== controls.model || saved.controls.sessionHash !== controls.sessionHash);
  const valid = controls.model.trim() && typeof controls.multiplier === 'number' && controls.multiplier >= 0.1 && controls.multiplier <= 10
    && typeof controls.hours === 'number' && controls.hours >= 1 && controls.hours <= 168;
  return <section className={styles.scenario} aria-label="Fleet scenario">
    <h4>Fleet scenario</h4>
    <p className={styles.note}>Capture eligible accounts for one physical model. Compare demand and availability using retained quota evidence.</p>
    <Group align="end" gap="sm" className={styles.controls}>
      <TextInput label="Fleet model" placeholder="cc/model-name" value={controls.model} onChange={event => update('model', event.target.value)} w={170} />
      <NumberInput label="Demand multiplier" value={controls.multiplier} onChange={value => update('multiplier', value)} min={0.1} max={10} step={0.1} suffix=" ×" w={140} />
      <NumberInput label="Projection hours" value={controls.hours} onChange={value => update('hours', value)} min={1} max={168} w={140} />
      <TextInput label="Existing session hash" placeholder="Optional" value={controls.sessionHash} onChange={event => update('sessionHash', event.target.value)} w={170} />
      <Button disabled={!valid || busy} onClick={() => run(true)}>{saved ? 'Recapture fleet' : 'Capture fleet'}</Button>
    </Group>
    {saved && <Group align="end" gap="sm" className={styles.controls}>
      <MultiSelect label="Unavailable accounts" searchable data={options} value={controls.excludedConnectionIds} onChange={value => update('excludedConnectionIds', value)} w={280} />
      <Select label="New-session account preference" placeholder="Gateway policy" clearable data={options} value={controls.preferredConnectionId || null} onChange={value => update('preferredConnectionId', value || '')} w={280} />
      <Button variant="light" disabled={!valid || busy || captureChanged} onClick={() => run(false)}>Compare captured fleet</Button>
    </Group>}
    {busy && <p role="status">Calculating captured fleet…</p>}
    {captureChanged && <p className={styles.note}>Model or session changed. Recapture to compare this scope.</p>}
    {error && <Alert color="orange" title="Fleet scenario unavailable">{error}</Alert>}
    {result && <div aria-live="polite" aria-label="Fleet comparison">
      <p className={styles.note}>Captured {quotaTimestamp(result.capturedAt)} UTC · {result.projectionPeriod.hours} h · {result.scenario.multiplier} × demand. Baseline {result.baseline.connectionId || result.baseline.reason} → scenario {result.changed.connectionId || result.changed.reason}.</p>
      <p className={styles.note}>Captured records {quotaTimestamp(result.retainedPeriod.start)} to {quotaTimestamp(result.retainedPeriod.end)} UTC (end exclusive). Each product’s windows overlap. Transferred demand and monetary savings are unknown.</p>
      {result.preferenceSuppressedBySession && <p className={styles.notice}>The captured session keeps its account continuity; a new-session preference does not move it.</p>}
      {result.accounts.map(account => <div key={account.connectionId} className={styles.fleetAccount}>
        <h4>{account.connectionId} · {account.eligibility === 'gateway-candidate-or-affinity-held' ? 'Eligible on capture' : account.eligibility.replaceAll('-', ' ')}</h4>
        {!account.evidenceComplete ? <p>Incomplete history. No account forecast.</p> : !account.products.length ? <p>No retained quota observations.</p> : account.products.map(product => <div key={product.id} role="group" aria-label={`${account.connectionId} ${product.label} product`} className={styles.productGroup}>
          <p className={styles.productLabel}>{product.label}</p>
          <div className={styles.fleetWindows}>{product.windows.map(window => <div key={window.seriesId} className={styles.fleetWindow}>
            <strong>{window.label}</strong><span>{quotaNumber(window.observedBalance?.value)} {window.unit || 'unknown units'} · {window.resourceType?.replaceAll('-', ' ') || 'resource unknown'}</span>
            {window.evidenceState !== 'available' && <span>Evidence {window.evidenceState.replaceAll('_', ' ')}</span>}
            <span>Baseline {stateLabel(window.original)}</span><span>Scenario {stateLabel(window.adjusted)}</span>
            <span>Net depletion {quotaNumber(window.evidence.observedDepletion)} · net replenishment {quotaNumber(window.evidence.observedReplenishment)} {window.unit}</span>
            {window.evidence.rollingReleaseEnvelopes.length > 0 && <span>{window.evidence.rollingReleaseEnvelopes.length} conditional rolling expiry intervals; recovery amount unknown.</span>}
            <details><summary>{window.contributingRecords.length} contributing records and assumptions</summary>
              <p>Balance observed {quotaTimestamp(window.observedBalance?.observedAt)} UTC. Median net depletion {window.rate ? `${quotaNumber(window.rate.median)} ${window.rate.unit}` : 'unknown'}.</p>
              <p>Scenario sensitivity {quotaTimestamp(window.adjusted.earliestAt)} to {window.adjusted.latestAt ? `${quotaTimestamp(window.adjusted.latestAt)} UTC` : 'an unknown or reset-limited late horizon'}. Gross consumption and replenishment are unknown. These are not confidence intervals.</p>
              {window.evidence.rollingReleaseEnvelopes.map(envelope => <p key={envelope.afterId}>Conditional expiry {quotaTimestamp(envelope.earliestAt)} to {quotaTimestamp(envelope.latestAt)} UTC · {quotaNumber(envelope.observedNetDepletion)} {envelope.unit} retained net depletion · {envelope.status}.</p>)}
              <p>{window.evidence.censoredIntervals} censored intervals. Recorded reset {quotaTimestamp(window.original.resetAt)} UTC, completion unverified.</p>
              <div className={styles.evidenceLinks}>{window.contributingRecords.map(record => <a key={record.id} href={record.href} target="_blank" rel="noreferrer">{record.id}</a>)}</div>
            </details>
          </div>)}</div>
        </div>)}
      </div>)}
      <details className={styles.increases}><summary>Scenario assumptions and uncertainty</summary><ul>{result.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul><code>{result.captureId}</code></details>
    </div>}
  </section>;
}
