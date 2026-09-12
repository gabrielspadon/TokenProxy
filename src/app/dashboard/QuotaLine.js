'use client';
import { useMemo } from 'react';
import { Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { Icon } from '@/shared/components/Icon';
import { accountWindowObservationStale, accountWindowStale, accountWindowTime } from './accountControlPanelModel';
import { resetShort, windowHeadroom, windowHiddenId, windowLevel, windowReplenished } from './accountBoardModel';
import styles from '@/shared/workspace/board.module.css';

const number = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)
    : '—';

// The windows a person hid, per browser, shared by every view that draws
// quota lines so a window hidden on the board is hidden everywhere.
export function useHiddenWindows() {
  const [list, setList] = useLocalStorage({
    key: 'tokenproxy.capacity-hidden-windows',
    defaultValue: [],
  });
  const hiddenWindows = useMemo(() => new Set(list), [list]);
  const setWindowHidden = (account, key, hidden) => {
    const id = windowHiddenId(account, key);
    setList((previous) =>
      hidden ? [...new Set([...previous, id])] : previous.filter((value) => value !== id)
    );
  };
  return { hiddenWindows, setWindowHidden };
}

// One quota window: label, meter, remaining, reset. The hide control sits
// over the line's end and shows on hover or focus, so it costs no width.
// `threshold` is the Advanced auto-pause editor, rendered by the caller.
export function QuotaLine({ window, now, onInspect, onHide, threshold = null }) {
  const known = Number.isFinite(window.remaining) && !window.unlimited;
  const stale = accountWindowStale(window, now);
  const estimated = known && windowReplenished(window, now) && !accountWindowObservationStale(window, now);
  const remaining = estimated ? windowHeadroom(window, now) : window.remaining;
  const level = windowLevel({ ...window, remaining, resetAt: null }, now);
  const valueText = `${estimated ? 'Estimated ' : ''}${number(remaining)} percent remaining`;
  const observed = accountWindowTime(window.observedAt, now);
  const reset = accountWindowTime(window.resetAt, now, true);
  const evidence = `${window.key}: ${known ? valueText : window.unlimited ? 'unlimited' : 'remaining unknown'}. ${estimated ? `Estimated after reset; last observed ${number(window.remaining)}% remaining. ` : ''}${observed.label}. ${reset.label}.${window.threshold > 0 ? ` Auto-pause at ${number(window.threshold)}% remaining.` : ''}`;
  return (
    <div className={styles.line} data-stale={stale || undefined} data-level={level || undefined}>
      <button
        type="button"
        className={styles.lineLabel}
        title={evidence}
        onClick={() => onInspect(window.key)}
      >
        {window.label}
      </button>
      <Tooltip label={evidence}>
        <div
          className={styles.meter}
          role={known ? 'meter' : undefined}
          aria-label={known ? `${window.key} remaining` : undefined}
          aria-valuemin={known ? 0 : undefined}
          aria-valuemax={known ? 100 : undefined}
          aria-valuenow={known ? remaining : undefined}
          aria-valuetext={known ? valueText : undefined}
          data-unknown={!known || undefined}
        >
          {known ? <span className={styles.fill} style={{ width: `${remaining}%` }} /> : null}
          {window.threshold > 0 && !window.unlimited ? (
            <span className={styles.threshold} style={{ left: `${window.threshold}%` }} />
          ) : null}
        </div>
      </Tooltip>
      <span className={styles.lineValue}>
        {window.unlimited ? '∞' : known ? `${estimated ? '≈' : ''}${number(remaining)}%` : '—'}
      </span>
      <span className={styles.lineReset} title={reset.label}>
        {resetShort(window, now)}
      </span>
      {threshold}
      {onHide ? (
        <Tooltip label="Hide this window">
          <button
            type="button"
            className={styles.lineHide}
            aria-label={`Hide ${window.label}`}
            onClick={() => onHide(window.key)}
          >
            <Icon name="i-hide" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

// The count of windows off the card, in the state row so hiding a window
// never adds a line. Opens the list below the lines.
export function HiddenCount({ hidden, name, open, onToggle }) {
  if (!hidden.length) return null;
  return (
    <Tooltip label={`${hidden.length} hidden ${hidden.length === 1 ? 'window' : 'windows'}`}>
      <button
        type="button"
        className={styles.hiddenCount}
        aria-label={`Hidden windows for ${name}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="i-hide" />
        {hidden.length}
      </button>
    </Tooltip>
  );
}

// The hidden windows, with the way back for the ones the person hid. A
// window hidden by the depletion rule returns on its own.
export function HiddenWindows({ hidden, onShow }) {
  if (!hidden.length) return null;
  return (
    <div className={styles.hiddenRow} aria-label="Hidden windows">
      {hidden.map((window) =>
        window.reason === 'manual' && onShow ? (
          <Tooltip key={window.key} label="Show this window again">
            <button
              type="button"
              className={styles.hiddenChip}
              aria-label={`Show ${window.label}`}
              onClick={() => onShow(window.key)}
            >
              <Icon name="i-show" />
              {window.label}
            </button>
          </Tooltip>
        ) : (
          <Tooltip
            key={window.key}
            label={
              window.reason === 'manual'
                ? 'Hidden from the board. Show it again there.'
                : 'Hidden while the longer window is depleted. It returns when that window has room again.'
            }
          >
            <span className={styles.hiddenChip} data-auto>
              {window.label}
            </span>
          </Tooltip>
        )
      )}
    </div>
  );
}
