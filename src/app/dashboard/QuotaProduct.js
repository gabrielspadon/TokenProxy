'use client';
import { useId } from 'react';
import { NumberInput } from '@mantine/core';
import { accountWindowStale, accountWindowTime } from './accountControlPanelModel';
import styles from './quotaProduct.module.css';

const number = value => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);

export function QuotaProduct({ group, mode, now, onInspect, thresholdFor, onThresholdChange, disabled }) {
  const headingId = useId();
  const helpId = useId();
  const nextReset = group.windows.filter(window => Date.parse(window.resetAt) > now)
    .reduce((next, window) => !next || Date.parse(window.resetAt) < Date.parse(next.resetAt) ? window : next, null);
  const observedTimes = new Set(group.windows.map(window => window.observedAt));
  const commonObserved = observedTimes.size === 1 ? accountWindowTime(group.windows[0]?.observedAt, now) : null;
  return <section className={styles.product} aria-labelledby={headingId} data-quota-product={group.id}>
    <header className={styles.heading}><h3 id={headingId}>{group.label}</h3><span title={commonObserved?.absolute || undefined}>{commonObserved ? commonObserved.label : `${group.windows.length} ${group.windows.length === 1 ? 'window' : 'windows'}`}</span></header>
    <div className={styles.columns} aria-hidden="true"><span>Window</span><span>{mode === 'used' ? 'Used' : 'Remaining'}</span><span>Pause ≤</span></div>
    <div className={styles.lanes}>{group.windows.map(window => {
      const known = Number.isFinite(window.remaining) && !window.unlimited;
      const value = known ? mode === 'remaining' ? window.remaining : 100 - window.remaining : null;
      const reset = accountWindowTime(window.resetAt, now, true);
      const observed = accountWindowTime(window.observedAt, now);
      const stale = accountWindowStale(window, now);
      const low = known && window.remaining <= Math.max(10, window.threshold);
      const threshold = thresholdFor(window.key);
      const pauseLabel = window.unlimited ? 'Auto-pause not applied to unlimited quota' : window.threshold > 0 ? `Pause ≤ ${number(window.threshold)}% left` : 'Auto-pause off';
      return <div className={styles.lane} key={window.key} data-quota-window={window.key} data-retained={stale || !known || undefined}>
        <button className={styles.windowName} type="button" onClick={() => onInspect(window.key)} aria-label={`Inspect ${window.key}`} title={window.key}>{window.label}</button>
        <div className={styles.measure}>
          <div className={styles.track}>
          <div className={styles.meter} role={known ? 'meter' : undefined} aria-label={known ? `${window.key} ${mode}` : undefined} aria-hidden={!known || undefined} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={value ?? undefined} aria-valuetext={known ? `${number(value)} percent ${mode}; ${stale ? 'retained' : 'observed'} capacity` : undefined} data-unknown={!known || undefined}>
            {known ? <span className={styles.fill} data-low={low || undefined} style={{ width: `${value}%` }} /> : null}
            {window.threshold > 0 && !window.unlimited ? <span className={styles.threshold} style={{ left: `${mode === 'remaining' ? window.threshold : 100 - window.threshold}%` }} title={pauseLabel} /> : null}
          </div>
          {Number.isFinite(threshold) && !window.unlimited ? <input className={styles.slider} type="range" min="0" max="100" step="1" value={threshold} dir={mode === 'used' ? 'rtl' : 'ltr'} aria-label={`Adjust auto-pause for ${window.key}`} aria-valuetext={`${number(threshold)} percent remaining; zero turns auto-pause off`} aria-describedby={helpId} title="Drag the marker to set the pause reserve" onChange={event => onThresholdChange(window.key, Number(event.currentTarget.value))} disabled={disabled} /> : null}
          </div>
          <strong className={styles.value} data-low={low || undefined}>{window.unlimited ? 'Unlimited' : value === null ? 'Unknown' : `${number(value)}%`}</strong>
          <span className={styles.screenReader}>{pauseLabel}</span>
        </div>
        <div className={styles.reserve}>
          <NumberInput aria-label={`Auto-pause threshold for ${window.key}`} description="Pause at % remaining. 0% is off." classNames={{ description: styles.screenReader }} inputWrapperOrder={['input', 'description']} suffix="%" min={0} max={100} value={threshold} placeholder="?" onChange={value => onThresholdChange(window.key, value)} disabled={disabled} hideControls />
          {!Number.isFinite(threshold) || window.unlimited ? <span className={styles.unapplied}>{window.unlimited ? 'Not applied' : 'Unavailable'}</span> : null}
        </div>
        <div className={styles.metadata}>
          <span title={reset.absolute || undefined} data-next-reset={nextReset?.key === window.key || undefined}>{reset.label}{nextReset?.key === window.key && group.windows.length > 1 ? <span className={styles.next}> · next reset</span> : null}</span>
          {!commonObserved ? <span title={observed.absolute || undefined}>{observed.label}</span> : null}
          {stale && observed.absolute ? <span className={styles.stale}>{Date.parse(window.resetAt) <= now ? 'Retained' : 'Stale'}</span> : null}
        </div>
      </div>;
    })}</div>
    <footer className={styles.footnote}><span id={helpId}>Drag marker to pause at % remaining. 0% is off.</span></footer>
  </section>;
}
