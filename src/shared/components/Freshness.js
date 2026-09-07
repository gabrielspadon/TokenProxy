'use client';
import { useEffect, useState } from 'react';
import { fmtRelative, fmtTime } from '@/shared/format';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';

const LABEL = {
  live: 'Live',
  stale: 'Stale since',
  reconnecting: 'Reconnecting',
  connecting: 'Connecting',
  summary: 'Observed',
  paused: 'Paused',
  historical: 'Historical',
  snapshot: 'Snapshot',
};

// Visible state of one stream or poll: live, stale since, reconnecting.
export function Freshness({ status, lastDataAt }) {
  const workspace = useOptionalWorkspace();
  const snapshot = workspace?.snapshot;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot) return undefined;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [snapshot]);
  const when = lastDataAt ? new Date(lastDataAt).toISOString() : null;
  if (snapshot)
    return (
      <span className="fresh" data-state="snapshot" role="status">
        {snapshot.kind === 'synthetic-fixture' ? 'Synthetic fixture' : 'Snapshot'}
      </span>
    );
  const observation = workspace?.observations;
  const displayedStatus = observation && !observation.background && !['stale','connecting','reconnecting'].includes(status)
    ? observation.historical ? 'historical' : observation.mode
    : status;
  return (
    <span className="fresh" data-state={displayedStatus} role="status">
      {LABEL[displayedStatus] || displayedStatus}
      {displayedStatus === 'stale' && when ? <span data-i18n-skip>{fmtTime(when)}</span> : null}
      {['live','summary','paused','historical'].includes(displayedStatus) && when && now - lastDataAt >= 5000 ? (
        <span data-i18n-skip>{fmtRelative(when, now)}</span>
      ) : null}
    </span>
  );
}
