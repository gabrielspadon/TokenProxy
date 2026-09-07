'use client';
import { Ruler } from './Ruler';
import { fmtNum, fmtRelative, isEpoch } from '@/shared/format';

const CONF = { measured: 'Measured', estimated: 'Estimated', unknown: 'Not measured' };

// One quota window: who, the band of what is used, and its reset on the ruler.
export function QuotaWindow({ provider, name, window: w, horizonMs, now }) {
  const known = w.limit > 0 && w.remaining !== null && w.remaining !== undefined;
  const usedFrac = known ? Math.min(1, Math.max(0, 1 - w.remaining / w.limit)) : 0;
  const level = !known
    ? undefined
    : w.remaining === 0
      ? 'empty'
      : w.remaining / w.limit < 0.15
        ? 'low'
        : undefined;
  const reset = isEpoch(w.resetAt) ? null : w.resetAt;
  return (
    <div className="row window">
      <div className="who">
        <span className="name">
          {name || provider}
        </span>
        <span className="sub">
          <span>{w.scope}</span>
        </span>
      </div>
      <div>
        <div className="band" data-confidence={w.confidence} data-level={level} aria-hidden="true">
          <span className="used" style={{ width: `${usedFrac * 100}%` }} />
        </div>
        <div className="band-meta">
          {known ? (
            <span>
              <span>
                {fmtNum(w.remaining)} / {fmtNum(w.limit)}
              </span>{' '}
              remaining
            </span>
          ) : (
            <span>Remaining is not known</span>
          )}
          <span>
            {known
              ? `${fmtNum(usedFrac * 100, { maximumFractionDigits: 1 })}% used`
              : CONF[w.confidence] || w.confidence}
          </span>
          {known ? <span>{CONF[w.confidence] || w.confidence}</span> : null}
        </div>
      </div>
      <div>
        <Ruler horizonMs={horizonMs} now={now} marks={reset ? [{ at: reset }] : []} />
        <div className="band-meta">
          {reset ? (
            <span>
              Resets <span>{fmtRelative(reset, now)}</span>
            </span>
          ) : (
            <span>Reset time is not known</span>
          )}
          {isEpoch(w.observedAt) ? (
            <span>Never observed</span>
          ) : (
            <span>
              Seen <span>{fmtRelative(w.observedAt, now)}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
