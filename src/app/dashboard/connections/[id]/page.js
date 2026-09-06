"use client";
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePoll } from "@/shared/hooks/usePoll";
import { Freshness } from "@/shared/components/Freshness";
import { Notice } from "@/shared/components/Notice";
import { Confirm } from "@/shared/components/Confirm";
import { QuotaWindow } from "@/shared/components/QuotaWindow";
import { call } from "@/shared/api";
import { refusal } from "@/shared/refusal";
import { runGrant, importPasted } from "@/shared/oauthGrant";
import { TONE, WORDS, AUTH } from "@/shared/status";
import { fmtNum, fmtRelative, fmtTime, fmtDuration, isEpoch } from "@/shared/format";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import "../styles.css";

const HORIZON_MS = 6 * 60 * 60 * 1000;

function pollFresh(p) {
  if (p.loading) return "connecting";
  if (p.error && p.goodAt) return "stale";
  if (p.error) return "reconnecting";
  return "live";
}

const KIND_WORD = Object.fromEntries(MEDIA_PROVIDER_KINDS.map((k) => [k.id, k.label]));
KIND_WORD.chat = "Chat";

// Copy for every action, before it fires. §1 and §3 of DESIGN.md.
const COPY = {
  enable: { title: "Enable this connection", verb: "Enable", requires: "An operator session.", changes: "The account rejoins the fallback order and can receive traffic.", undo: "Disable it again." },
  disable: { title: "Disable this connection", verb: "Disable", requires: "An operator session.", changes: "The account leaves the fallback order. In-flight requests finish.", undo: "Enable it again." },
  priority: { title: "Change the priority", verb: "Save", requires: "An operator session.", changes: "The account moves in the fallback order the next time a request routes.", undo: "Set the old value back." },
  thresholds: { title: "Set the quota pause thresholds", verb: "Save", requires: "An operator session.", changes: "The gateway pauses this account when a window's use crosses the threshold.", undo: "Clear the thresholds." },
  pool: { title: "Bind a proxy pool", verb: "Save", requires: "An operator session, and an active pool.", changes: "Every upstream call from this account goes through the pool. Whether that is strict comes from the pool itself.", undo: "Bind no pool." },
  endpoint: { title: "Override the endpoint", verb: "Save", requires: "An operator session, and an absolute http or https URL.", changes: "Calls go to the new base URL in the chosen API shape instead of the provider default.", undo: "Clear the override." },
  concurrent: { title: "Set the provider's concurrency ceiling", verb: "Save", requires: "An operator session.", changes: "Every connection of this provider shares the new ceiling, not only this one.", undo: "Clear the ceiling and the default of 80 applies." },
  recheck: { title: "Recheck this connection", verb: "Recheck", requires: "The connection not draining, and no other probe in flight.", changes: "One real request goes upstream and its verdict replaces the recorded standing.", undo: "Nothing to undo. A failed probe only updates the record." },
  drain: { title: "Drain this connection", verb: "Drain", requires: "An operator session from this machine, and the drain record unchanged since this screen read it.", changes: "New requests stop landing here. Streams already open run to their end.", undo: "Cancel the drain." },
  undrain: { title: "Cancel the drain", verb: "Cancel the drain", requires: "An operator session from this machine, and the drain record unchanged since this screen read it.", changes: "The account starts taking new requests again.", undo: "Drain it again." },
  reauth: { title: "Replace the credential", verb: "Sign in", requires: "An operator session, and finishing the provider's own sign-in as the same account.", changes: "The stored credential is replaced in place. History and priority stay.", undo: "None. The old credential is overwritten." , irreversible: true },
  del: { title: "Delete this connection", verb: "Delete", requires: "An operator session.", changes: "The stored credential, the connection's configuration, and its place in the fallback order are destroyed. Nothing else cascades.", undo: "None. Add the account again from the start.", irreversible: true },
};

export default function ConnectionPage({ params }) {
  const { id } = use(params);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const conn = usePoll(`/api/providers/${id}`, 10000);
  const qual = usePoll(`/api/admin/qualification/${id}`, 10000);
  const drain = usePoll("/api/admin/drain?all=true", 10000);
  const settings = usePoll("/api/settings", 30000);
  const pools = usePoll("/api/proxy-pools", 30000);

  const c = conn.data?.connection || null;
  const d = qual.data || null;
  const drainState = useMemo(
    () => (drain.data?.connections || []).find((x) => x.connectionId === id) || null,
    [drain.data, id],
  );
  const entry = c ? AI_PROVIDERS[c.provider] : null;
  const psd = c?.providerSpecificData || {};
  const maxConcurrent = c ? settings.data?.providerStrategies?.[c.provider]?.maxConcurrent : undefined;
  const poolList = pools.data?.proxyPools || [];
  const pool = psd.proxyPoolId ? poolList.find((p) => p.id === psd.proxyPoolId) : null;

  const status = d?.status || (c?.isActive === false ? "unqualified" : "healthy");
  const kinds = entry?.serviceKinds?.length ? entry.serviceKinds : ["chat"];

  // ---- actions -----------------------------------------------------------
  const [action, setAction] = useState(null); // key of COPY
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [field, setField] = useState({});
  const [probe, setProbe] = useState(null); // last recheck generation shown inline
  const [grantStep, setGrantStep] = useState(null);

  function openAction(kind, seed = {}) {
    setRefused(null);
    setGrantStep(null);
    setField(seed);
    setAction(kind);
  }
  const close = () => { setAction(null); setBusy(false); setRefused(null); };

  async function run() {
    setBusy(true);
    setRefused(null);
    let r;
    const ver = drainState?.version;
    switch (action) {
      case "enable": r = await call(`/api/providers/${id}`, { method: "PUT", body: { isActive: true } }); break;
      case "disable": r = await call(`/api/providers/${id}`, { method: "PUT", body: { isActive: false } }); break;
      case "priority": r = await call(`/api/providers/${id}`, { method: "PUT", body: { priority: Number(field.priority) } }); break;
      case "thresholds": {
        const t = {};
        for (const [k, v] of Object.entries(field)) if (v !== "" && v !== undefined) t[k] = Number(v);
        r = await call(`/api/providers/${id}`, { method: "PUT", body: { quotaPauseThresholds: t } });
        break;
      }
      case "pool": r = await call(`/api/providers/${id}`, { method: "PUT", body: { proxyPoolId: field.poolId || "__none__" } }); break;
      case "endpoint": r = await call(`/api/providers/${id}`, { method: "PUT", body: { baseUrl: field.baseUrl || "", ...(field.apiType ? { apiType: field.apiType } : {}) } }); break;
      case "concurrent": {
        const v = field.maxConcurrent === "" ? undefined : Number(field.maxConcurrent);
        r = await call("/api/settings", { method: "PATCH", body: { providerStrategies: { [c.provider]: v === undefined ? {} : { maxConcurrent: v } } } });
        break;
      }
      case "recheck": {
        r = await call(`/api/admin/qualification/${id}/recheck`, { method: "POST", body: field.force ? { force: true } : {} });
        if (r.ok) setProbe(r.body.generation || null);
        break;
      }
      case "drain": r = await call(`/api/admin/drain/${id}`, { method: "POST", body: ver ? { ifMatch: ver } : {} }); break;
      case "undrain": r = await call(`/api/admin/drain/${id}?${new URLSearchParams(ver ? { ifMatch: ver } : {})}`, { method: "DELETE" }); break;
      case "reauth": {
        if (!entry?.hasOAuth) {
          r = await call(`/api/providers/${id}/reauth`, { method: "POST", body: { [c.authType === "cookie" ? "accessToken" : "apiKey"]: field.secret, ...(field.force ? { force: true } : {}) } });
        } else {
          const flowProbe = await call(`/api/oauth/${c.provider}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`);
          const kind = flowProbe.ok ? flowProbe.body.flowType : "authorization_code";
          const reauth = { reauthConnectionId: id, ...(field.force ? { forceReauth: true } : {}) };
          const out = (kind === "browser_token" || kind === "import_token")
            ? await importPasted(c.provider, { token: field.secret, machineId: field.machineId, reauth })
            : await runGrant(c.provider, kind, { reauth, report: setGrantStep });
          r = out.ok ? { ok: true, status: 200, body: out.connection } : { ok: false, status: out.status, body: out.body };
        }
        break;
      }
      case "del": {
        r = await call(`/api/providers/${id}`, { method: "DELETE" });
        if (r.ok) { window.location.href = "/dashboard/connections"; return; }
        break;
      }
      default: r = { ok: false, status: 0, body: { error: "Nothing to do." } };
    }
    setBusy(false);
    if (r.ok) {
      close();
      conn.refresh(); qual.refresh(); drain.refresh(); settings.refresh();
    } else {
      setRefused(refusal(r.status, r.body));
    }
  }

  const copy = action ? COPY[action] : null;
  const notFound = conn.status === 404;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <p className="caption"><Link prefetch={false} href="/dashboard/connections">Connections</Link></p>
          <h1 data-i18n-skip>{c ? (c.name || c.displayName || c.email || c.provider) : "…"}</h1>
          {c ? <p className="caption"><span data-i18n-skip>{c.provider}</span> · {AUTH[c.authType] || c.authType}</p> : null}
        </div>
        <div className="actions">
          <Freshness status={pollFresh(qual)} lastDataAt={qual.goodAt} />
          <span className="status" data-tone={TONE[status] || "warn"}>{WORDS[status] || status}</span>
          {drainState?.isDraining ? <span className="status" data-tone="warn">Draining</span> : null}
        </div>
      </header>

      {notFound ? <Notice {...refusal(404, conn.error)} /> : null}
      {!notFound && conn.error && !c ? <Notice {...refusal(conn.status, conn.error)} /> : null}
      {conn.loading ? <div className="skeleton" aria-hidden="true" /> : null}

      {c ? (
        <>
          <section>
            <dl className="facts">
              <dt>Signed in as</dt><dd>{c.email ? <span data-i18n-skip>{c.email}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Priority</dt><dd data-i18n-skip>{fmtNum(c.priority ?? 0)}</dd>
              <dt>Enabled</dt><dd>{c.isActive === false ? "No" : "Yes"}</dd>
              <dt>Created</dt><dd>{c.createdAt ? <span data-i18n-skip>{fmtTime(c.createdAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Updated</dt><dd>{c.updatedAt ? <span data-i18n-skip>{fmtTime(c.updatedAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Rate limited until</dt><dd>{c.rateLimitedUntil && !isEpoch(c.rateLimitedUntil) ? <span data-i18n-skip>{fmtTime(c.rateLimitedUntil)}</span> : <span>Not rate limited</span>}</dd>
              <dt>Default model</dt><dd>{c.defaultModel ? <span data-i18n-skip>{c.defaultModel}</span> : <span>Provider default</span>}</dd>
              <dt>Endpoint</dt><dd>{psd.baseUrl ? <span data-i18n-skip>{psd.baseUrl} ({psd.apiType || "chat"})</span> : <span>Provider default</span>}</dd>
              <dt>Proxy pool</dt><dd>{pool ? <span data-i18n-skip>{pool.name}{pool.strictProxy ? " (strict)" : ""}</span> : psd.proxyPoolId ? <span data-i18n-skip>{psd.proxyPoolId}</span> : <span>None</span>}</dd>
              <dt>Provider ceiling</dt><dd>{maxConcurrent !== undefined ? <span data-i18n-skip>{fmtNum(maxConcurrent)}</span> : <span>Default of 80</span>}</dd>
            </dl>
            <p className="caption">Whether the proxy is strict is the pool&apos;s own setting; the connection only names the pool.</p>
          </section>

          <section>
            <h2>Services</h2>
            <p className="caption">What this provider can serve. A non-language service shares this credential and this lifecycle; it is not a stored thing of its own.</p>
            <ul className="bullets">
              {kinds.map((k) => <li key={k}>{KIND_WORD[k] || k}</li>)}
            </ul>
          </section>

          <section>
            <h2>Last probe</h2>
            {qual.error && !d ? <Notice {...refusal(qual.status, qual.error)} /> : null}
            {d || probe ? (
              <dl className="facts">
                <dt>Verdict</dt><dd>{(probe || d?.generation)?.ok ? "Answered" : (probe || d?.generation) ? "Failed" : "Never probed"}</dd>
                <dt>Model</dt><dd>{(probe || d?.generation)?.model ? <span data-i18n-skip>{(probe || d.generation).model}</span> : <span className="unreported">Not recorded</span>}</dd>
                <dt>Latency</dt><dd>{typeof (probe || d?.generation)?.latencyMs === "number" ? <span data-i18n-skip>{fmtDuration((probe || d.generation).latencyMs)}</span> : <span className="unreported">Not recorded</span>}</dd>
                <dt>Error</dt><dd>{(probe || d?.generation)?.error ? <span data-i18n-skip>{(probe || d.generation).error}</span> : <span>None</span>}</dd>
                <dt>Qualified</dt><dd>{d?.lastQualifiedAt ? <span data-i18n-skip>{fmtRelative(d.lastQualifiedAt, now)}</span> : <span className="unreported">Never</span>}</dd>
              </dl>
            ) : !qual.error ? <p className="empty">No probe on record.</p> : null}
            <div className="actions">
              <button type="button" className="button quiet" onClick={() => openAction("recheck", { force: false })}>Recheck</button>
            </div>
          </section>

          <section>
            <h2>Quota windows</h2>
            {d?.quota?.length ? (
              <div className="rows">
                {d.quota.map((w) => (
                  <QuotaWindow key={w.scope} provider={c.provider} name={w.scope} window={w} horizonMs={HORIZON_MS} now={now} />
                ))}
              </div>
            ) : <p className="empty">No windows observed for this account.</p>}
          </section>

          <section>
            <h2>Actions</h2>
            <div className="actions connections-actions">
              {c.isActive === false
                ? <button type="button" className="button" onClick={() => openAction("enable")}>Enable</button>
                : <button type="button" className="button quiet" onClick={() => openAction("disable")}>Disable</button>}
              <button type="button" className="button quiet" onClick={() => openAction("priority", { priority: String(c.priority ?? 1) })}>Priority</button>
              <button type="button" className="button quiet" onClick={() => openAction("thresholds", { ...(c.quotaPauseThresholds || {}) })}>Pause thresholds</button>
              <button type="button" className="button quiet" onClick={() => openAction("pool", { poolId: psd.proxyPoolId || "" })}>Proxy pool</button>
              <button type="button" className="button quiet" onClick={() => openAction("endpoint", { baseUrl: psd.baseUrl || "", apiType: psd.apiType || "" })}>Endpoint</button>
              <button type="button" className="button quiet" onClick={() => openAction("concurrent", { maxConcurrent: maxConcurrent === undefined ? "" : String(maxConcurrent) })}>Concurrency ceiling</button>
              {drainState?.isDraining
                ? <button type="button" className="button quiet" onClick={() => openAction("undrain")}>Cancel the drain</button>
                : <button type="button" className="button quiet" onClick={() => openAction("drain")}>Drain</button>}
              <button type="button" className="button quiet" onClick={() => openAction("reauth", { force: false, secret: "", machineId: "" })}>Replace the credential</button>
              <button type="button" className="button danger" onClick={() => openAction("del")}>Delete</button>
            </div>
            {drainState?.isDraining ? (
              <p className="caption">Draining since <span data-i18n-skip>{drainState.requestedAt ? fmtTime(drainState.requestedAt) : "—"}</span>, <span data-i18n-skip>{fmtNum(drainState.activeStreams)}</span> streams still open.</p>
            ) : null}
          </section>
        </>
      ) : null}

      <Confirm open={!!action} busy={busy} refusal={refused}
        title={copy?.title} verb={copy?.verb} requires={copy?.requires} changes={copy?.changes} undo={copy?.undo}
        irreversible={!!copy?.irreversible}
        onConfirm={run} onClose={close}>
        {action === "priority" ? (
          <label className="field"><span>Priority</span><input className="input" type="number" min="1" value={field.priority ?? ""} onChange={(e) => setField((f) => ({ ...f, priority: e.target.value }))} /></label>
        ) : null}
        {action === "thresholds" ? (
          <div className="connections-form">
            {(d?.quota?.length ? d.quota.map((w) => w.scope) : Object.keys(field).length ? Object.keys(field) : ["5h"]).map((scope) => (
              <label className="field" key={scope}>
                <span data-i18n-skip>{scope}</span>
                <input className="input" type="number" min="0" max="100" placeholder="No pause"
                  value={field[scope] ?? ""} onChange={(e) => setField((f) => ({ ...f, [scope]: e.target.value }))} />
              </label>
            ))}
            <p className="caption">Percent of the window used at which the gateway pauses this account. Empty means never.</p>
          </div>
        ) : null}
        {action === "pool" ? (
          <label className="field"><span>Pool</span>
            <select className="select" value={field.poolId ?? ""} onChange={(e) => setField((f) => ({ ...f, poolId: e.target.value }))}>
              <option value="">None</option>
              {poolList.filter((p) => p.isActive !== false).map((p) => <option key={p.id} value={p.id} data-i18n-skip>{p.name}</option>)}
            </select>
          </label>
        ) : null}
        {action === "endpoint" ? (
          <div className="connections-form">
            <label className="field"><span>Base URL</span><input className="input" type="url" placeholder={entry?.defaultBaseUrl || "https://"} value={field.baseUrl ?? ""} onChange={(e) => setField((f) => ({ ...f, baseUrl: e.target.value }))} /></label>
            <label className="field"><span>API shape</span>
              <select className="select" value={field.apiType ?? ""} onChange={(e) => setField((f) => ({ ...f, apiType: e.target.value }))}>
                <option value="">Provider default</option>
                <option value="chat">chat</option>
                <option value="responses">responses</option>
              </select>
            </label>
          </div>
        ) : null}
        {action === "concurrent" ? (
          <label className="field"><span>Ceiling</span><input className="input" type="number" min="1" placeholder="80" value={field.maxConcurrent ?? ""} onChange={(e) => setField((f) => ({ ...f, maxConcurrent: e.target.value }))} /></label>
        ) : null}
        {action === "recheck" ? (
          <label className="connections-check"><input type="checkbox" checked={!!field.force} onChange={(e) => setField((f) => ({ ...f, force: e.target.checked }))} /><span>Force, even if a result is fresh</span></label>
        ) : null}
        {action === "reauth" ? (
          <div className="connections-form">
            {!entry?.hasOAuth ? (
              <label className="field"><span>{c?.authType === "cookie" ? "Cookie value" : "API key"}</span><input className="input" type="password" autoComplete="off" value={field.secret ?? ""} onChange={(e) => setField((f) => ({ ...f, secret: e.target.value }))} /></label>
            ) : null}
            <label className="connections-check"><input type="checkbox" checked={!!field.force} onChange={(e) => setField((f) => ({ ...f, force: e.target.checked }))} /><span>Rebind even if the provider account differs</span></label>
            {grantStep ? <p className="caption">{grantStep}</p> : null}
          </div>
        ) : null}
        {action === "del" && c ? <p className="caption" data-i18n-skip>{c.name || c.email || c.provider}</p> : null}
      </Confirm>
    </div>
  );
}
