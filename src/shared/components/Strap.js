'use client';
import { usePoll } from '@/shared/hooks/usePoll';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { useUsageStream } from '@/store/usageStream';
import { Freshness } from './Freshness';
import { fmtNum, fmtPct } from '@/shared/format';

// The persistent instrument strip of DIRECTION-2 §1. Reads only routes the
// screens already consume: the usage stream and /api/system/state.
export function Strap() {
  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream('/api/usage/stream?period=today', apply);
  const state = usePoll('/api/system/state?windowSeconds=300', 15000);

  const m = state.data?.measures || {};
  const perMin =
    m.throughput?.value === null || m.throughput?.value === undefined
      ? null
      : m.throughput.value * 60;
  const errors = m.errorRate?.value ?? null;
  const conns = m.connectedUpstreams?.value ?? null;
  const active = (usage?.activeSessions || []).filter((s) => s.status === 'active').length;

  return (
    <div className="strap" role="status" aria-label="Telemetry" tabIndex={0}>
      <span className="cell">
        <Freshness status={stream.status} reason={stream.reason} lastDataAt={stream.lastDataAt || receivedAt} />
      </span>
      <span className="cell">
        <span className="fig">
          {perMin === null ? '—' : fmtNum(perMin, { maximumFractionDigits: perMin < 10 ? 1 : 0 })}
        </span>{' '}
        <span>req/min</span>
      </span>
      <span className="cell">
        <span className="fig">
          {usage ? fmtNum(active) : '—'}
        </span>{' '}
        <span>Sessions</span>
      </span>
      <span className="cell">
        <span className="fig">
          {conns === null ? '—' : fmtNum(conns)}
        </span>{' '}
        <span>Connections</span>
      </span>
      <span className="cell">
        <span className="fig" data-tone={errors ? 'warn' : undefined}>
          {errors === null ? '—' : fmtPct(errors)}
        </span>{' '}
        <span>Errors</span>
      </span>
    </div>
  );
}
