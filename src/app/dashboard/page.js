'use client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { useUsageStream } from '@/store/usageStream';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { QuotaWindow } from '@/shared/components/QuotaWindow';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { TrafficChart } from '@/shared/components/TrafficChart';
import { Icon } from '@/shared/components/Icon';
import { refusal } from '@/shared/refusal';
import { fmtDuration, fmtLatency, fmtNum, fmtPct, fmtRelative, fmtUsd } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';
import { RouteMap } from './RouteMap';
import { AccountInspector } from './AccountInspector';
import './routing.css';

const compact = (n) =>
  n == null ? '—' : fmtNum(n, { notation: 'compact', maximumFractionDigits: 1 });
const subscribeToOrigin = () => () => {};
const getEndpoint = () => `${window.location.origin}/v1`;
const getServerEndpoint = () => '/v1';
function Kpi({ label, value, foot, icon, tone }) {
  return (
    <div className="kpi" data-tone={tone}>
      <div className="kpi-label">
        {label}
        <Icon name={icon} />
      </div>
      <div className="kpi-value" data-i18n-skip>
        {value}
      </div>
      <div className="kpi-foot">{foot}</div>
    </div>
  );
}
export default function NowPage() {
  const health = usePoll('/api/admin/health', 15000);
  const detail = usePoll('/api/admin/health/detail', 15000);
  const state = usePoll('/api/system/state?windowSeconds=3600', 15000);
  const quota = usePoll('/api/admin/quota', 30000);
  const [period, setPeriod] = useState('today');
  const [connectionId, setConnectionId] = useState(null);
  const chart = usePoll(`/api/usage/chart?period=${period}`, 30000);
  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream('/api/usage/stream?period=today', apply);
  const [metric, setMetric] = useState('requests');
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const m = state.data?.measures || {};
  const conns = useMemo(() => detail.data?.checks?.connections || [], [detail.data]);
  const windows = useMemo(
    () =>
      (quota.data?.snapshots || []).flatMap((s) =>
        (s.windows || []).map((w) => ({
          key: `${s.connectionId}:${w.scope}`,
          provider: s.provider,
          name: conns.find((c) => c.connectionId === s.connectionId)?.displayName || s.provider,
          window: w,
        }))
      ),
    [quota.data, conns]
  );
  const reqs = usage?.recentRequests || [];
  const tokens = usage
    ? Object.values(usage.byProvider || {}).reduce(
        (n, r) => n + (r.promptTokens || 0) + (r.completionTokens || 0),
        0
      )
    : null;
  const endpoint = useSyncExternalStore(subscribeToOrigin, getEndpoint, getServerEndpoint);
  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <>
      <div className="screen-head">
        <div className="page-title">
          <h1>Overview</h1>
          <p className="screen-subtitle">A live view of every route, request, and decision.</p>
        </div>
        <Link href="/dashboard/connections" className="button quiet">
          <Icon name="i-add" />
          Add connection
        </Link>
        <button
          className="button"
          onClick={() => {
            health.refresh();
            detail.refresh();
            state.refresh();
            quota.refresh();
            chart.refresh();
          }}
        >
          <Icon name="i-refresh" />
          Refresh
        </button>
      </div>
      {state.error ? <Notice {...refusal(state.status, state.error)} /> : null}
      <RouteMap
        usage={usage}
        conns={conns}
        stream={stream}
        receivedAt={receivedAt}
        selectedConnection={connectionId || conns[0]?.connectionId}
        onSelectConnection={setConnectionId}
      />
      <div className="kpi-grid">
        <Kpi
          label="Tokens today"
          value={compact(tokens)}
          foot="Input + output in today’s usage ledger"
          icon="i-usage"
        />
        <Kpi
          label="Spend today"
          value={usage?.totalCost == null ? '—' : fmtUsd(usage.totalCost)}
          foot="Recorded cost in today’s usage ledger"
          icon="i-shaping"
        />
        <Kpi
          label="Response latency · p95"
          value={m.latencyP95?.value == null ? '—' : fmtLatency(m.latencyP95.value)}
          foot="Slowest 5% boundary · last hour"
          icon="i-now"
        />
        <Kpi
          label="Error rate"
          value={m.errorRate?.value == null ? '—' : fmtPct(m.errorRate.value)}
          foot="Measured requests · last hour"
          icon="i-access"
          tone={m.errorRate?.value > 0.05 ? 'warn' : undefined}
        />
      </div>
      <div className="operator-grid overview-analytics">
        <section className="operator-panel" aria-labelledby="traffic-title">
          <div className="panel-head">
            <div>
              <h2 id="traffic-title">Traffic over time</h2>
              <p>Recorded gateway traffic</p>
            </div>
            <div className="segment-buttons" aria-label="Traffic period">
              {[
                ['today', 'Today'],
                ['7d', '7 days'],
                ['30d', '30 days'],
              ].map(([id, label]) => (
                <button key={id} aria-pressed={period === id} onClick={() => setPeriod(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body">
            <div className="segment-buttons" aria-label="Chart measure">
              {['requests', 'tokens', 'cost'].map((v) => (
                <button key={v} onClick={() => setMetric(v)} aria-pressed={metric === v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            {chart.error ? (
              <Notice {...refusal(chart.status, chart.error)} />
            ) : chart.loading ? (
              <div className="chart-empty skeleton">Reading traffic</div>
            ) : (
              <TrafficChart data={Array.isArray(chart.data) ? chart.data : []} metric={metric} />
            )}
          </div>
        </section>
        <AccountInspector
          conns={conns}
          selectedId={connectionId}
          onSelect={setConnectionId}
          quota={quota}
          usage={usage}
          healthError={detail.error ? refusal(detail.status, detail.error) : null}
          now={now}
        />
      </div>
      <div className="operator-grid overview-activity">
        <section className="operator-panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <div>
              <h2 id="recent-title">Recent requests</h2>
              <p>Latest events from the usage stream</p>
            </div>
            <Link className="text-link" href="/dashboard/usage">
              All activity
              <Icon name="i-right" />
            </Link>
          </div>
          <div className="panel-body">
            {reqs.length ? (
              reqs.slice(0, 5).map((r, i) => (
                <div key={r.id || `${r.timestamp}-${i}`} className="request-row">
                  <ProviderMark provider={r.provider} size="small" />
                  <span className="request-model" data-i18n-skip>
                    {r.model || r.provider}
                    <small>{fmtRelative(r.timestamp, now)}</small>
                  </span>
                  <span data-i18n-skip>
                    {compact((r.promptTokens || 0) + (r.completionTokens || 0))} tokens
                  </span>
                  <span className="status" data-tone={r.status === 'error' ? 'bad' : 'ok'}>
                    {r.status === 'error'
                      ? 'Failed'
                      : r.status === 'pending'
                        ? 'Pending'
                        : 'Completed'}
                  </span>
                </div>
              ))
            ) : (
              <p className="empty">
                Requests appear here after your first call through the gateway.
              </p>
            )}
          </div>
        </section>
        <section className="operator-panel" aria-labelledby="quota-title">
          <div className="panel-head">
            <div>
              <h2 id="quota-title">Quota headroom</h2>
              <p>Provider-reported limits</p>
            </div>
            <Link className="text-link" href="/dashboard/connections">
              Details
              <Icon name="i-right" />
            </Link>
          </div>
          <div className="panel-body">
            {quota.error ? (
              <Notice {...refusal(quota.status, quota.error)} />
            ) : windows.length ? (
              windows
                .slice(0, 3)
                .map((w) => (
                  <QuotaWindow
                    key={w.key}
                    provider={w.provider}
                    name={w.name}
                    window={w.window}
                    horizonMs={6 * 3600000}
                    now={now}
                  />
                ))
            ) : (
              <p className="empty">
                No quota windows reported yet. Limits appear when a provider includes them.
              </p>
            )}
          </div>
        </section>
      </div>
      <div className="endpoint-bar">
        <Icon name="i-network" />
        <span className="endpoint-label">Gateway endpoint</span>
        <code data-i18n-skip>{endpoint}</code>
        <button className="button quiet" onClick={copyEndpoint}>
          <Icon name={copied ? 'i-check' : 'i-copy'} />
          {copied ? 'Copied' : 'Copy endpoint'}
        </button>
        <Link href="/dashboard/keys" className="text-link">
          Manage keys
          <Icon name="i-right" />
        </Link>
      </div>
      {copyError ? (
        <Notice
          tone="warn"
          title="Copy was blocked by the browser."
          next="Select and copy the endpoint above."
        />
      ) : null}
      <div className="runtime-facts">
        <span>
          Gateway{' '}
          <strong>
            {health.data
              ? `up ${fmtDuration(health.data.uptimeSeconds * 1000)}`
              : health.loading
                ? 'checking'
                : 'unavailable'}
          </strong>
        </span>
        <span>
          Database <strong>{detail.data?.checks?.database?.status || 'not reported'}</strong>
        </span>
        <span>
          Connected upstreams <strong>{m.connectedUpstreams?.value ?? '—'}</strong>
        </span>
        <Freshness status={stream.status} lastDataAt={receivedAt} />
      </div>
      {state.data?.unanswerable?.length ? (
        <details className="fold">
          <summary>Telemetry coverage</summary>
          <p>
            Unavailable measures remain unknown. Model-specific cooldowns and quota pause decisions
            may not be included in connection health.
          </p>
          <ul className="bullets">
            {state.data.unanswerable.map((v, i) => (
              <li key={i}>
                {typeof v === 'string'
                  ? v
                  : v.reason || v.unavailable || v.name || 'This measure is not available.'}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
