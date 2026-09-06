'use client';
import { Progress, Tooltip, UnstyledButton } from '@mantine/core';
import styles from './quotaEvidence.module.css';

export function orderQuotaWindows(windows) {
  return [...windows].sort(
    (a, b) =>
      (b.durationMs ?? -1) - (a.durationMs ?? -1) || (a.scope || '').localeCompare(b.scope || '')
  );
}

export function quotaPercentage(window) {
  const value = window?.percentage?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function observation(value) {
  return value && Number.isFinite(Date.parse(value))
    ? `${new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`
    : 'unknown';
}

function evidenceLabel(window) {
  const percentage = quotaPercentage(window);
  return `${window.scope || 'Unspecified scope'}. ${
    percentage === null
      ? 'Comparable remaining percentage is unknown; the stored denominator is not evidence of entitlement.'
      : `${percentage}% remaining, retained in connection.lastQuotaSnapshot. Observed ${observation(window.percentage.observedAt)}; ${window.percentage.freshness?.state || 'unknown age'}. Percentage reset ${observation(window.percentage.resetAt)}.`
  }`;
}

export function WindowEvidence({ window }) {
  if (!window) return <span className={styles.unknown}>Not recorded</span>;
  const percentage = quotaPercentage(window);
  return (
    <Tooltip label={evidenceLabel(window)} multiline w={360}>
      <div className={styles.evidence}>
        <span className={percentage === null ? styles.unknown : styles.measure}>
          {percentage === null ? 'Unknown headroom' : `${percentage}% remaining`}
        </span>
        {percentage !== null && (
          <Progress
            aria-label={`${window.scope} retained remaining percentage`}
            value={percentage}
            color={window.percentage.freshness?.state === 'fresh' ? 'indigo' : 'gray'}
            size={3}
            radius={0}
          />
        )}
      </div>
    </Tooltip>
  );
}

export function QuotaSummary({ windows, onInspect }) {
  if (!windows.length) return <span className={styles.unknown}>Not recorded</span>;
  return (
    <div className={styles.summary} aria-label="Remaining percentage by quota window">
      {orderQuotaWindows(windows).map((window) => {
        const percentage = quotaPercentage(window);
        return (
          <Tooltip key={window.scope} label={evidenceLabel(window)} multiline w={360}>
            <UnstyledButton
              className={styles.window}
              onClick={() => onInspect?.(window.scope)}
              aria-label={`Inspect ${window.scope}, ${percentage === null ? 'remaining unknown' : `${percentage}% remaining`}`}
            >
              <span className={styles.scope}>{window.scope || 'Unspecified'}</span>
              <span
                className={percentage === null ? styles.unknown : styles.measure}
                data-low={(percentage !== null && percentage <= 10) || undefined}
              >
                {percentage === null ? 'Unknown' : `${percentage}%`}
              </span>
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </div>
  );
}
