'use client';
import { useMemo, useState } from 'react';
import { usePoll } from '@/shared/hooks/usePoll';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { useUsageStream } from '@/store/usageStream';
import { Confirm } from '@/shared/components/Confirm';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Measure } from '@/shared/components/Measure';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtPct, fmtTime, fmtUnit, fmtUsd } from '@/shared/format';
import './styles.css';

// The six values every /api/usage/* route accepts. An unknown one silently
// falls back to today on the stream and is a 400 on stats and chart, so the
// picker never offers one they do not share.
const PERIODS = [
  ['today', 'Today'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['60d', '60 days'],
  ['all', 'All time'],
];
const GRAINS = [
  ['provider', 'Provider'],
  ['account', 'Connection'],
  ['model', 'Model on a connection'],
];
const OUTCOME = { success: ['ok', 'Succeeded'], ok: ['ok', 'Succeeded'], error: ['bad', 'Failed'] };
const NO_LATENCY =
  'no request in this period carries a measured response time, so there is no average to report';
const NO_TTFT =
  'no request in this period carries a measured time to first token, so there is no average to report';
const NO_RATE = 'nothing in this period read or wrote the cache, so there is no rate to compute';

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// The start of the window a period names, as the statistics route wants it.
// That route takes startDate and endDate only; it has no period parameter.
function startOf(period) {
  const now = new Date();
  if (period === 'all') return null;
  if (period === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = { '24h': 1, '7d': 7, '30d': 30, '60d': 60 }[period] || 7;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

// One rollup bucket drawn as a proportional band. Cost leads because it is the
// question the screen exists to answer; tokens and requests sit beside it.
function Bucket({ name, sub, row, max, priced }) {
  const cost = row.cost || 0;
  const tokens = (row.promptTokens || 0) + (row.completionTokens || 0);
  const unpriced = cost === 0 && (row.requests || 0) > 0 && !priced;
  return (
    <div className="row usage-grid">
      <span className="who">
        <span className="name" data-i18n-skip>
          {name}
        </span>
        {sub ? (
          <span className="sub" data-i18n-skip>
            {sub}
          </span>
        ) : null}
      </span>
      <span>
        <span className="band" aria-hidden="true">
          <span className="used" style={{ width: `${max > 0 ? (cost / max) * 100 : 0}%` }} />
        </span>
        <span className="band-meta">
          <span data-i18n-skip>{fmtNum(row.requests || 0)}</span>
          <span data-i18n-skip>{fmtNum(tokens)}</span>
        </span>
      </span>
      {unpriced ? (
        <span className="unreported">Not priced</span>
      ) : (
        <span data-i18n-skip>{fmtUsd(cost)}</span>
      )}
    </div>
  );
}

// `name` and `sub` are resolvers, never the bucket's own map key: byApiKey is
// keyed by `hmac:<digest>|model|provider`, so rendering the key would put a
// key-derived identifier on screen. Every breakdown names its readable field.
function Breakdown({ id, title, buckets, empty, priced, label, name, sub }) {
  const rows = Object.entries(buckets || {}).sort(
    (a, b) => (b[1].cost || 0) - (a[1].cost || 0) || (b[1].requests || 0) - (a[1].requests || 0)
  );
  const max = rows.reduce((n, [, r]) => Math.max(n, r.cost || 0), 0);
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="rows">
          <div className="row head usage-grid">
            <span>{label}</span>
            <span>Requests and tokens</span>
            <span>Cost</span>
          </div>
          {rows.map(([k, r]) => (
            <Bucket key={k} name={name(r, k)} sub={sub?.(r)} row={r} max={max} priced={priced(r)} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function UsagePage() {
  const [period, setPeriod] = useState('7d');
  const [grain, setGrain] = useState('provider');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream(`/api/usage/stream?period=${period}`, apply);

  const since = useMemo(() => startOf(period), [period]);
  const statsUrl = useMemo(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (since) q.set('startDate', since);
    return `/api/usage/statistics?${q}`;
  }, [since, page]);
  const stats = usePoll(statsUrl, 30000);
  const health = usePoll(`/api/usage/stats/health?period=${period}&groupBy=${grain}`, 30000);
  const chart = usePoll(`/api/usage/chart?period=${period}`, 60000);
  const bodies = usePoll('/api/usage/request-details?pageSize=1', 60000);
  const settings = usePoll('/api/settings', 0);
  const pricing = usePoll('/api/pricing', 0);

  // ponytail: a model id is looked up across every provider rather than by the
  // bucket's own provider, because a rollup carries the provider's DISPLAY name
  // while the pricing table is keyed by its id. Narrow this if two providers
  // ever price the same model id differently.
  const priced = useMemo(() => {
    const set = new Set();
    for (const models of Object.values(pricing.data || {}))
      for (const m of Object.keys(models || {})) set.add(m);
    return set;
  }, [pricing.data]);
  const isPriced = useMemo(() => (r) => priced.has(r.rawModel || r.model || ''), [priced]);

  const fresh = usage && usage.period === period;
  const sum = stats.data?.summary;
  const lat = sum?.latency;
  const items = stats.data?.items || [];
  const pager = stats.data?.pagination;
  const series = chart.data || [];
  const peak = series.reduce((n, b) => Math.max(n, b.cost || 0), 0);
  const active = usage?.activeRequests || [];
  const layerOn = bodies.data?.observability?.enabled === true;

  const send = async () => {
    if (!pending) return;
    setBusy(true);
    const res = await call(pending.url, { method: pending.method, body: pending.body });
    setBusy(false);
    if (!res.ok) {
      setFailed(refusal(res.status, res.body));
      return;
    }
    setFailed(null);
    setPending(null);
    (pending.after || [])?.forEach?.((p) => p.refresh());
  };

  const saveLayer = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const on = f.get('enabled') === 'on';
    const num = (k, d) => Math.max(1, parseInt(f.get(k), 10) || d);
    setFailed(null);
    setPending({
      url: '/api/settings',
      method: 'PATCH',
      after: [bodies, settings],
      body: {
        enableObservability: on,
        observabilityMaxRecords: num('maxRecords', 1000),
        observabilityBatchSize: num('batchSize', 20),
        observabilityFlushIntervalMs: num('flushMs', 5000),
        observabilityMaxJsonSize: num('maxJson', 5),
      },
      title: on ? 'Turn on full-body recording' : 'Turn off full-body recording',
      verb: on ? 'Turn it on' : 'Turn it off',
      irreversible: false,
      requires: 'An operator session on this gateway.',
      changes: on
        ? 'Every request from now on stores its request and response bodies, secrets redacted and each body truncated at the size below. The per-request counts, costs and rollups on this screen are recorded either way and do not change.'
        : 'Body recording stops. Records already stored stay until the cap prunes them. The per-request counts, costs and rollups on this screen are unaffected.',
      undo: 'Turn it back the other way here. Bodies recorded while it was on are not removed by turning it off.',
    });
  };

  const resetPrices = () => {
    setFailed(null);
    setPending({
      url: '/api/pricing',
      method: 'DELETE',
      after: [pricing],
      title: 'Reset every price override',
      verb: 'Reset every override',
      irreversible: true,
      requires: 'An operator session on this gateway.',
      changes:
        'Every price you have set, for every model of every provider, is deleted. Each of those models falls back to its built-in default price. No usage record, token count or past cost is touched.',
      undo: 'There is none. The overrides are not kept anywhere else and would have to be entered again one model at a time.',
    });
  };

  return (
    <>
      <div className="screen-head">
        <h1>Usage</h1>
        <Freshness status={stream.status} lastDataAt={receivedAt} />
      </div>

      <div className="usage-controls">
        <fieldset className="segmented usage-segmented">
          <legend>Period</legend>
          {PERIODS.map(([v, l]) => (
            <label key={v}>
              <input
                type="radio"
                name="period"
                value={v}
                checked={period === v}
                onChange={() => {
                  setPeriod(v);
                  setPage(1);
                }}
              />
              <span>{l}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <section aria-labelledby="h-totals">
        <div className="screen-head">
          <h2 id="h-totals">Totals</h2>
          <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
        </div>
        {stats.error && !stats.data ? <Notice {...refusal(stats.status, stats.error)} /> : null}
        {stream.status === 'stale' ? (
          <Notice
            tone="warn"
            title="The usage stream stopped."
            next="Counts below are from the last frame received. Reconnecting in the background."
          />
        ) : null}
        {!fresh ? <p className="skeleton">Waiting for the first frame of this period</p> : null}
        <div className="measures tiles">
          <Measure
            big
            label="Cost"
            measure={fresh ? { value: usage.totalCost ?? null } : null}
            render={fmtUsd}
          />
          <Measure
            big
            label="Requests"
            measure={fresh ? { value: usage.totalRequests ?? null } : null}
            render={fmtNum}
          />
          <Measure
            big
            label="Tokens"
            measure={sum ? { value: sum.totalTokens } : null}
            render={fmtNum}
          />
          <Measure
            label="Input tokens, cache excluded"
            measure={sum ? { value: sum.inputTokens } : null}
            render={fmtNum}
          />
          <Measure
            label="Output tokens"
            measure={sum ? { value: sum.outputTokens } : null}
            render={fmtNum}
          />
          <Measure
            label="Cache read tokens"
            measure={sum ? { value: sum.cacheReadTokens } : null}
            render={fmtNum}
          />
          <Measure
            label="Cache write tokens"
            measure={sum ? { value: sum.cacheCreationTokens } : null}
            render={fmtNum}
          />
          <Measure
            label="Cache hit rate"
            measure={sum ? { value: sum.cacheHitRate, unavailable: NO_RATE } : null}
            render={fmtPct}
          />
        </div>
        <p className="caption">
          Cost and requests come from the live stream. The token breakdown comes from the 45-day
          request record, which is a different table and can differ at the edges of a period.
        </p>
      </section>

      <section aria-labelledby="h-speed">
        <h2 id="h-speed">Response time</h2>
        <div className="measures tiles">
          <Measure
            big
            label="Average total time"
            measure={lat ? { value: lat.avgLatencyMs, unavailable: NO_LATENCY } : null}
            render={(v) => fmtUnit(v, 'millisecond')}
          />
          <Measure
            big
            label="Average time to first token"
            measure={lat ? { value: lat.avgTtftMs, unavailable: NO_TTFT } : null}
            render={(v) => fmtUnit(v, 'millisecond')}
          />
          <Measure
            label="Requests timed"
            measure={lat ? { value: lat.latencySamples } : null}
            render={fmtNum}
          />
          <Measure
            label="Requests timed to first token"
            measure={lat ? { value: lat.ttftSamples } : null}
            render={fmtNum}
          />
        </div>
        <p className="caption">
          Each average counts only the requests that measured it. A large share of older records
          never did, so the sample count sits beside every average rather than being folded into it.
        </p>
      </section>

      <section aria-labelledby="h-overtime">
        <div className="screen-head">
          <h2 id="h-overtime">Cost over time</h2>
          <Freshness status={pollFresh(chart)} lastDataAt={chart.goodAt} />
        </div>
        {chart.error && !chart.data ? <Notice {...refusal(chart.status, chart.error)} /> : null}
        {chart.data && series.length === 0 ? (
          <p className="empty">
            This period has no buckets to draw. Choose a longer period, or send a request through
            the gateway.
          </p>
        ) : null}
        {/* Every bucket at zero draws as a flat 120px band of nothing, which
            reads as a broken chart rather than as "no cost was recorded". Say
            that instead, and keep the numbers fold below either way. */}
        {series.length > 0 && peak <= 0 ? (
          <p className="empty">
            Every bucket in this period recorded no cost. Requests still ran; the numbers below say
            how many.
          </p>
        ) : null}
        {series.length ? (
          <>
            {peak > 0 ? (
              <>
                <ul className="spark" aria-hidden="true" data-i18n-skip>
                  {series.map((b, i) => (
                    <li
                      key={b.bucketStart ?? `${b.label}-${i}`}
                      data-peak={(b.cost || 0) === peak ? 'true' : undefined}
                      style={{
                        height: `${Math.max(1, ((b.cost || 0) / peak) * 100)}%`,
                        animationDelay: `${Math.min(i * 12, 360)}ms`,
                      }}
                      title={`${b.label} ${fmtUsd(b.cost || 0)}`}
                    />
                  ))}
                </ul>
                <p className="spark-meta">
                  <span data-i18n-skip>{series[0]?.label}</span>
                  <span>
                    <span>Peak</span> <span data-i18n-skip>{fmtUsd(peak)}</span>
                  </span>
                  <span data-i18n-skip>{series[series.length - 1]?.label}</span>
                </p>
              </>
            ) : null}
            <details className="fold">
              <summary>Every bucket as numbers</summary>
              <div className="rows">
                <div className="row head usage-grid">
                  <span>Bucket</span>
                  <span>Tokens</span>
                  <span>Cost</span>
                </div>
                {series.map((b, i) => (
                  <div key={b.bucketStart ?? `${b.label}-${i}`} className="row usage-grid">
                    <span className="who">
                      <span className="name" data-i18n-skip>
                        {b.label}
                      </span>
                    </span>
                    <span>
                      <span className="band" aria-hidden="true">
                        <span
                          className="used"
                          style={{ width: `${peak > 0 ? ((b.cost || 0) / peak) * 100 : 0}%` }}
                        />
                      </span>
                      <span className="band-meta">
                        <span data-i18n-skip>{fmtNum(b.tokens || 0)}</span>
                      </span>
                    </span>
                    <span data-i18n-skip>{fmtUsd(b.cost || 0)}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        ) : null}
      </section>

      <Breakdown
        id="h-by-provider"
        title="By provider"
        label="Provider"
        buckets={fresh ? usage.byProvider : null}
        name={(r, k) => k}
        priced={() => true}
        empty="No provider served a request in this period."
      />
      <Breakdown
        id="h-by-model"
        title="By model"
        label="Model"
        buckets={fresh ? usage.byModel : null}
        name={(r, k) => r.rawModel || k}
        sub={(r) => r.provider}
        priced={isPriced}
        empty="No model served a request in this period."
      />
      <Breakdown
        id="h-by-connection"
        title="By connection"
        label="Model on a connection"
        buckets={fresh ? usage.byAccount : null}
        name={(r, k) => r.accountName || k}
        sub={(r) => [r.rawModel, r.provider].filter(Boolean).join(' ')}
        priced={isPriced}
        empty="No connection served a request in this period."
      />
      <Breakdown
        id="h-by-key"
        title="By client key"
        label="Key"
        buckets={fresh ? usage.byApiKey : null}
        name={keyLabel}
        sub={(r) => [r.rawModel, r.provider].filter(Boolean).join(' ')}
        priced={isPriced}
        empty="No client key spent anything in this period."
      />
      <Breakdown
        id="h-by-endpoint"
        title="By endpoint"
        label="Endpoint"
        buckets={fresh ? usage.byEndpoint : null}
        name={(r, k) => r.endpoint || k}
        sub={(r) => [r.rawModel, r.provider].filter(Boolean).join(' ')}
        priced={isPriced}
        empty="No endpoint was called in this period."
      />

      <section aria-labelledby="h-health">
        <div className="screen-head">
          <h2 id="h-health">Provider health</h2>
          <Freshness status={pollFresh(health)} lastDataAt={health.goodAt} />
        </div>
        <fieldset className="segmented usage-segmented">
          <legend>Grouped by</legend>
          {GRAINS.map(([v, l]) => (
            <label key={v}>
              <input
                type="radio"
                name="grain"
                value={v}
                checked={grain === v}
                onChange={() => setGrain(v)}
              />
              <span>{l}</span>
            </label>
          ))}
        </fieldset>
        {health.error && !health.data ? <Notice {...refusal(health.status, health.error)} /> : null}
        {health.data && (health.data.rows || []).length === 0 ? (
          <p className="empty">
            Nothing was measured in this period at this grouping. Choose a longer period.
          </p>
        ) : null}
        {(health.data?.rows || []).length ? (
          <div className="rows">
            <div className="row head usage-health">
              <span>Who</span>
              <span>Requests</span>
              <span>Errors</span>
              <span>Success rate</span>
              <span>Average time</span>
            </div>
            {health.data.rows.map((r) => (
              <div
                key={`${r.provider}|${r.connectionId || ''}|${r.model || ''}`}
                className="row usage-health"
              >
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {r.account || r.providerName || r.provider}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {[r.model, r.account ? r.providerName || r.provider : null]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                </span>
                <span data-i18n-skip>{fmtNum(r.requests)}</span>
                <span data-i18n-skip>{fmtNum(r.errors)}</span>
                {r.successRate === null ? (
                  <span className="unreported">Not measured</span>
                ) : (
                  <span data-i18n-skip>{fmtPct(r.successRate)}</span>
                )}
                {r.avgLatencyMs === null ? (
                  <span className="unreported">Not measured</span>
                ) : (
                  <span data-i18n-skip>
                    {fmtUnit(r.avgLatencyMs, 'millisecond')} ({fmtNum(r.latencySamples)})
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : null}
        <p className="caption">
          A group that measured no outcome reads as not measured, never as a clean record.
        </p>
      </section>

      <section aria-labelledby="h-flight">
        <h2 id="h-flight">In flight</h2>
        {!usage ? <p className="skeleton">Waiting for the first frame</p> : null}
        {usage && active.length === 0 ? (
          <p className="empty">No request is in flight right now.</p>
        ) : null}
        {active.length ? (
          <div className="rows">
            <div className="row head usage-flight">
              <span>Model</span>
              <span>Connection</span>
              <span>Running</span>
            </div>
            {active.map((a) => (
              <div key={`${a.account}|${a.model}`} className="row usage-flight">
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {a.model}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {a.provider}
                  </span>
                </span>
                <span data-i18n-skip>{a.account}</span>
                <span data-i18n-skip>{fmtNum(a.count)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {usage?.errorProvider ? (
          <Notice
            tone="warn"
            title="A provider is returning errors."
            detail={usage.errorProvider}
          />
        ) : null}
      </section>

      <section aria-labelledby="h-history">
        <div className="screen-head">
          <h2 id="h-history">Request history</h2>
          <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
        </div>
        {stats.data && items.length === 0 ? (
          <p className="empty">
            No request was recorded in this period. Send one through the gateway, or choose a longer
            period.
          </p>
        ) : null}
        {items.length ? (
          <div className="rows">
            <div className="row head usage-history">
              <span>Time</span>
              <span>Model</span>
              <span>Connection</span>
              <span>Tokens in and out</span>
              <span>Time</span>
              <span>Outcome</span>
            </div>
            {items.map((it) => {
              const [tone, word] = OUTCOME[it.status] || ['warn', it.status];
              return (
                <div
                  key={`${it.timestamp}|${it.model}|${it.account}`}
                  className="row usage-history"
                >
                  <span data-i18n-skip>{fmtTime(it.timestamp)}</span>
                  <span className="who">
                    <span className="name" data-i18n-skip>
                      {it.model}
                    </span>
                    <span className="sub" data-i18n-skip>
                      {it.provider}
                    </span>
                  </span>
                  <span data-i18n-skip>{it.account}</span>
                  <span data-i18n-skip>
                    {fmtNum(it.inputTokens)} / {fmtNum(it.outputTokens)}
                  </span>
                  {it.latencyMs === null ? (
                    <span className="unreported">Not measured</span>
                  ) : (
                    <span data-i18n-skip>{fmtUnit(it.latencyMs, 'millisecond')}</span>
                  )}
                  <span className="status" data-tone={tone}>
                    {word}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {pager && (pager.hasPrev || pager.hasNext) ? (
          <div className="usage-pager">
            <button
              type="button"
              className="button quiet"
              disabled={!pager.hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Newer
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={!pager.hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Older
            </button>
            <span className="caption" data-i18n-skip>
              {fmtNum(pager.page)} / {fmtNum(pager.totalPages)}
            </span>
          </div>
        ) : null}
        <p className="caption">
          Each row is one request. Its cost is not among the fields this record keeps, so cost is
          read from the rollups above rather than per request.
        </p>
      </section>

      <section aria-labelledby="h-bodies">
        <h2 id="h-bodies">Full-body records</h2>
        {bodies.error && !bodies.data ? <Notice {...refusal(bodies.status, bodies.error)} /> : null}
        <dl className="facts">
          <dt>Recording</dt>
          <dd>
            {bodies.data ? (
              <span className="status" data-tone={layerOn ? 'ok' : 'warn'}>
                {layerOn ? 'On' : 'Off'}
              </span>
            ) : (
              <span className="skeleton">Reading</span>
            )}
          </dd>
          <dt>Records held</dt>
          <dd>
            {bodies.data ? (
              <span data-i18n-skip>{fmtNum(bodies.data.pagination?.totalItems || 0)}</span>
            ) : (
              <span className="skeleton">Reading</span>
            )}
          </dd>
          <dt>Cap</dt>
          <dd>
            {settings.data ? (
              <span data-i18n-skip>{fmtNum(settings.data.observabilityMaxRecords || 0)}</span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
        </dl>
        {bodies.data && !layerOn ? (
          <Notice
            tone="info"
            title="Bodies are not being recorded."
            next="An empty list here means the layer is off, not that nothing happened. Every count, cost and rollup above is recorded either way."
          />
        ) : null}
        <p>
          Bodies are secret-redacted, truncated at the size below, and pruned oldest first once the
          cap is reached. This is a rolling window. The per-request counts above keep a longer,
          separate 45-day record.
        </p>
        <details className="usage-details panel fold">
          <summary>Change what is recorded</summary>
          {settings.data ? (
            <form className="usage-form" onSubmit={saveLayer} key={String(layerOn)}>
              <label className="field">
                <span>Record request and response bodies</span>
                <input type="checkbox" name="enabled" defaultChecked={layerOn} />
              </label>
              <label className="field">
                <span>Most records to keep</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  name="maxRecords"
                  defaultValue={settings.data.observabilityMaxRecords || 1000}
                />
              </label>
              <label className="field">
                <span>Records written per batch</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  name="batchSize"
                  defaultValue={settings.data.observabilityBatchSize || 20}
                />
              </label>
              <label className="field">
                <span>Milliseconds between flushes</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  name="flushMs"
                  defaultValue={settings.data.observabilityFlushIntervalMs || 5000}
                />
              </label>
              <label className="field">
                <span>Largest body kept, in kilobytes</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  name="maxJson"
                  defaultValue={settings.data.observabilityMaxJsonSize || 5}
                />
              </label>
              <span>
                <button type="submit" className="button">
                  Save
                </button>
              </span>
            </form>
          ) : (
            <p className="skeleton">Reading</p>
          )}
        </details>
      </section>

      <section aria-labelledby="h-pricing">
        <h2 id="h-pricing">Pricing</h2>
        {pricing.error && !pricing.data ? (
          <Notice {...refusal(pricing.status, pricing.error)} />
        ) : null}
        <p>
          Every cost on this screen is worked out from token counts against these prices, in dollars
          per million tokens. A model with no price here contributes nothing and reads as not
          priced.
        </p>
        <p className="unreported">
          Which of these prices is a built-in default and which is your override is not reported.
          The gateway serves the two merged into one table and exposes no route for the override set
          on its own.
        </p>
        {fresh && Object.keys(usage.byModel || {}).length ? (
          <div className="rows">
            <div className="row head usage-price">
              <span>Model</span>
              <span>Price</span>
            </div>
            {Object.entries(usage.byModel).map(([k, m]) => (
              <div key={k} className="row usage-price">
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {m.rawModel || k}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {m.provider}
                  </span>
                </span>
                {isPriced(m) ? (
                  <span data-i18n-skip>{fmtUsd(cheapest(pricing.data, m.rawModel))}</span>
                ) : (
                  <span className="unreported">Not priced</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">
            No model was used in this period, so there is nothing to price. Choose a longer period.
          </p>
        )}
        <p className="usage-pager">
          <button type="button" className="button danger" onClick={resetPrices}>
            <Icon name="i-delete" />
            Reset every price override
          </button>
        </p>
      </section>

      <section aria-labelledby="h-retention">
        <h2 id="h-retention">What is kept</h2>
        <ul className="bullets">
          <li>Per-request counts, times and outcomes are kept for 45 days, then pruned.</li>
          <li>
            Full request and response bodies are a separate, opt-in, much shorter rolling window,
            capped by count and pruned oldest first.
          </li>
          <li>
            A client key is stored, but only ever shown back masked. No usage view re-exposes the
            value it was issued with.
          </li>
        </ul>
        <h3>Not reported</h3>
        <ul className="bullets">
          <li>
            Cost per individual request. The record the history above reads from keeps no cost
            column, so cost is only ever rolled up.
          </li>
          <li>
            The lifetime request counter for this install, and the day-by-day rollup, are both
            maintained but no route serves either.
          </li>
          <li>
            Reasoning tokens, and which of the two models a request asked for against the one that
            answered it, are recorded per request but the history route does not return them.
          </li>
        </ul>
      </section>

      <Confirm
        open={!!pending}
        busy={busy}
        refusal={failed}
        title={pending?.title || ''}
        verb={pending?.verb || ''}
        requires={pending?.requires}
        changes={pending?.changes}
        undo={pending?.undo}
        irreversible={pending?.irreversible}
        onConfirm={send}
        onClose={() => {
          setPending(null);
          setFailed(null);
        }}
      />
    </>
  );
}

// keyName falls back server-side to `<mask> (<hmac tail>)` for a key with no
// operator name. The mask is shown back by design; the hmac tail is a stable
// pseudonym derived from the key value, so it never reaches the screen.
function keyLabel(r) {
  if (r.apiKeyMasked && r.keyName?.includes(r.apiKeyMasked)) return r.apiKeyMasked;
  return r.keyName || r.apiKeyMasked || '';
}

// The input price of a model, whichever provider prices it. Output and cache
// rates are on the same row upstream; the one number here is the entry price.
function cheapest(table, model) {
  let best = null;
  for (const models of Object.values(table || {})) {
    const p = models?.[model];
    if (p && typeof p.input === 'number' && (best === null || p.input < best)) best = p.input;
  }
  return best ?? 0;
}
