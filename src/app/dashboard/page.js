"use client";
import { useEffect, useMemo, useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { useEventStream } from "@/shared/hooks/useEventStream";
import { useUsageStream } from "@/store/usageStream";
import { Freshness } from "@/shared/components/Freshness";
import { Measure } from "@/shared/components/Measure";
import { Notice } from "@/shared/components/Notice";
import { QuotaWindow } from "@/shared/components/QuotaWindow";
import { Ruler } from "@/shared/components/Ruler";
import { refusal } from "@/shared/refusal";
import { fmtDuration, fmtNum, fmtPct, fmtRelative, fmtUnit, fmtUsd } from "@/shared/format";
import { TONE, WORDS as STATUS } from "@/shared/status";

const HORIZON_MS = 6 * 3600 * 1000;
const WORDS = { ...STATUS, live: "Receiving requests", idle: "Idle", empty: "No requests yet", unknown: "Not known" };

function pollFresh(p) {
  if (p.loading) return "connecting";
  if (p.error && p.goodAt) return "stale";
  if (p.error) return "reconnecting";
  return "live";
}

export default function NowPage() {
  const health = usePoll("/api/admin/health", 15000);
  const detail = usePoll("/api/admin/health/detail", 15000);
  const state = usePoll("/api/system/state?windowSeconds=3600", 15000);
  const quota = usePoll("/api/admin/quota", 30000);
  const apply = useUsageStream((s) => s.apply);
  const usage = useUsageStream((s) => s.data);
  const receivedAt = useUsageStream((s) => s.receivedAt);
  const stream = useEventStream("/api/usage/stream?period=today", apply);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);

  const m = state.data?.measures || {};
  const fresh = state.data?.freshness;
  const conns = detail.data?.checks?.connections || [];
  const db = detail.data?.checks?.database;
  const sessions = usage?.activeSessions || [];
  const active = sessions.filter((s) => s.status === "active");
  const byProvider = useMemo(() => {
    const out = new Map();
    for (const s of active) out.set(s.provider, (out.get(s.provider) || 0) + 1);
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [active]);
  const windows = useMemo(() => {
    const names = new Map(conns.map((c) => [c.connectionId, c.displayName]));
    return (quota.data?.snapshots || []).flatMap((s) => (s.windows || []).map((w) => ({ key: `${s.connectionId}:${w.scope}`, provider: s.provider, name: names.get(s.connectionId) || s.provider, window: w })));
  }, [quota.data, conns]);

  return (
    <>
      <div className="screen-head">
        <h1>Now</h1>
        <Freshness status={stream.status} lastDataAt={receivedAt} />
      </div>

      <section aria-labelledby="h-gateway">
        <h2 id="h-gateway">Gateway</h2>
        {health.error && !health.data ? <Notice {...refusal(health.status, health.error)} /> : null}
        <dl className="facts">
          <dt>Process</dt>
          <dd>{health.data ? <><span className="status" data-tone="ok">Up</span> <span data-i18n-skip>{fmtDuration(health.data.uptimeSeconds * 1000)}</span></> : health.loading ? <span className="skeleton">Reading</span> : <span className="status" data-tone="bad">Not answering</span>}</dd>
          <dt>Database</dt>
          <dd>{db ? <><span className="status" data-tone={TONE[db.status] || "warn"}>{WORDS[db.status] || db.status}</span> <span className="id" data-i18n-skip>{db.driver}</span> {db.latencyMs !== undefined && db.latencyMs !== null ? <span data-i18n-skip>{fmtUnit(db.latencyMs, "millisecond")}</span> : null}{db.error ? <span className="caption" data-i18n-skip> {db.error}</span> : null}</> : detail.loading ? <span className="skeleton">Reading</span> : <span className="unreported">Not reported</span>}</dd>
          <dt>Upstream providers</dt>
          <dd>{state.data?.providerHealth ? <><span className="status" data-tone={TONE[state.data.providerHealth.status] || "warn"}>{WORDS[state.data.providerHealth.status] || state.data.providerHealth.status}</span>{state.data.providerHealth.degradedProviderCount ? <span data-i18n-skip> {fmtNum(state.data.providerHealth.degradedProviderCount)}</span> : null}{state.data.providerHealth.unavailable ? <span className="caption" data-i18n-skip> {state.data.providerHealth.unavailable}</span> : null}</> : <span className="unreported">Not reported</span>}</dd>
          <dt>Traffic</dt>
          <dd>{fresh ? <>{WORDS[fresh.state] || fresh.state}{fresh.lastEventAt ? <span data-i18n-skip> {fmtRelative(fresh.lastEventAt, now)}</span> : null}</> : <span className="unreported">Not reported</span>}</dd>
        </dl>
        {detail.data?.scanFailed ? <Notice tone="warn" title="The connection scan did not finish." next="The list below may be short. It runs again on the next read." /> : null}
      </section>

      <section aria-labelledby="h-hour">
        <div className="screen-head">
          <h2 id="h-hour">Last hour</h2>
          <Freshness status={pollFresh(state)} lastDataAt={state.goodAt} />
        </div>
        {state.error && !state.data ? <Notice {...refusal(state.status, state.error)} /> : null}
        <div className="measures">
          <Measure big label="Spent today" measure={usage ? { value: usage.totalCost ?? null } : null} render={fmtUsd} />
          <Measure label="Requests per second" measure={m.throughput} render={(v) => fmtNum(v, { maximumFractionDigits: 2 })} />
          <Measure label="Error rate" measure={m.errorRate} render={fmtPct} />
          <Measure label="Latency, slowest 5 percent" measure={m.latencyP95} render={(v) => fmtUnit(v, "millisecond")} />
          <Measure label="Spent in the window" measure={m.spend} render={fmtUsd} />
          <Measure label="Connected upstreams" measure={m.connectedUpstreams} render={fmtNum} />
          <Measure label="Degraded upstreams" measure={m.degradedUpstreams} render={fmtNum} />
          <Measure label="Failovers" measure={m.failoverCount} render={fmtNum} />
        </div>
        {state.data?.unanswerable?.length ? (
          <p className="caption">Some measures cannot be answered from what the gateway records. Each says why.</p>
        ) : null}
      </section>

      <section aria-labelledby="h-sessions">
        <h2 id="h-sessions">Sessions in flight</h2>
        {stream.status === "stale" ? <Notice tone="warn" title="The usage stream stopped." next="Counts below are from the last frame received. Reconnecting in the background." /> : null}
        {!usage && stream.status !== "stale" ? <p className="skeleton">Waiting for the first frame</p> : null}
        {usage && active.length === 0 ? <p className="empty">No request is in flight right now.</p> : null}
        {active.length ? (
          <div className="rows">
            <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="who"><span className="name">Active requests</span></span>
              <span className="value" data-i18n-skip>{fmtNum(active.length)}</span>
            </div>
            {byProvider.map(([p, n]) => (
              <div key={p} className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                <span className="who"><span className="name" data-i18n-skip>{p}</span></span>
                <span data-i18n-skip>{fmtNum(n)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {usage?.errorProvider ? <Notice tone="warn" title="A provider is returning errors." detail={usage.errorProvider} /> : null}
      </section>

      <section aria-labelledby="h-windows">
        <div className="screen-head">
          <h2 id="h-windows">Quota windows</h2>
          <Freshness status={pollFresh(quota)} lastDataAt={quota.goodAt} />
        </div>
        {quota.error && !quota.data ? <Notice {...refusal(quota.status, quota.error)} /> : null}
        {quota.data && windows.length === 0 ? <p className="empty">No connection reports a quota window yet. Windows appear after the first qualified request.</p> : null}
        {windows.length ? (
          <div className="rows">
            <div className="row head window"><span>Connection</span><span>Remaining</span><span>Reset on the next six hours</span></div>
            {windows.map((w) => <QuotaWindow key={w.key} provider={w.provider} name={w.name} window={w.window} horizonMs={HORIZON_MS} now={now} />)}
            <div className="row window"><span /><span /><Ruler horizonMs={HORIZON_MS} now={now} showScale /></div>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-conns">
        <h2 id="h-conns">Connections</h2>
        {detail.error && !detail.data ? <Notice {...refusal(detail.status, detail.error)} /> : null}
        {detail.data && conns.length === 0 ? <p className="empty">No connection is configured. Add one under Connections.</p> : null}
        {conns.length ? (
          <div className="rows">
            {conns.map((c) => (
              <div key={c.connectionId} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                <span className="who">
                  <span className="name" data-i18n-skip>{c.displayName || c.provider}</span>
                  <span className="sub"><span data-i18n-skip>{c.provider}</span>{c.lastError ? <> <span data-i18n-skip>{c.lastError}</span></> : null}</span>
                </span>
                <span className="status" data-tone={TONE[c.status] || "warn"}>{WORDS[c.status] || c.status}{c.isDraining ? <> <span>Draining</span></> : null}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <p>Two things the gateway acts on every time it routes reach no readable field, so this screen cannot show them.</p>
        <ul className="bullets">
          <li>Whether a connection is being skipped because a quota window crossed its auto-pause threshold. Such a connection reads as healthy above.</li>
          <li>Whether one model on a connection is locked out after a model-scoped failure, and until when.</li>
        </ul>
      </section>
    </>
  );
}
