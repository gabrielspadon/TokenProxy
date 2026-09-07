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
import { runGrant, importPasted, credentialDocument, requiresCredentialDocument } from "@/shared/oauthGrant";
import { TONE, WORDS, AUTH } from "@/shared/status";
import { fmtNum, fmtRelative, fmtTime, fmtDuration, isEpoch } from "@/shared/format";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { resolveAccountCapacity, resolveProviderCeiling } from "@/shared/utils/accountCapacity";
import { Icon } from "@/shared/components/Icon";
import { ProviderMark } from '@/shared/components/ProviderMark';
import { AccountModelAccess } from '../AccountModelAccess';
import AccountOptions from '../AccountOptions';
import AccountOperations from '../AccountOperations';
import { accountPath } from '../../network/accountPath';
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
  thresholds: { title: "Set the quota pause thresholds", verb: "Save", requires: "An operator session.", changes: "The gateway pauses new work on this account when an exact quota window has a known remaining percentage at or below its positive threshold.", undo: "Set a threshold to 0 or clear it to turn off pausing for that window." },
  pool: { title: "Bind a proxy pool", verb: "Save", requires: "An operator session, and an active pool.", changes: "Every upstream call from this account goes through the pool. Whether that is strict comes from the pool itself.", undo: "Bind no pool." },
  endpoint: { title: "Override the endpoint", verb: "Save", requires: "An operator session, and an absolute http or https URL.", changes: "Calls go to the new base URL in the chosen API shape instead of the provider default.", undo: "Clear the override." },
  concurrent: { title: "Set the provider's concurrency ceiling", verb: "Save", requires: "An operator session.", changes: "Every connection of this provider shares this additional outer ceiling. Independent account limits still apply.", undo: "Clear the provider ceiling to remove the outer limit. Account limits remain in effect." },
  recheck: { title: "Recheck this connection", verb: "Recheck", requires: "The connection not draining, and no other check in flight.", changes: "Runs the provider-specific validation and records its result. This may contact the provider, refresh credentials or consume quota. It does not establish that a model generated a response.", undo: "The observation remains recorded. A later check can replace the current result; credential refresh may also update stored credentials." },
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
  const networkPath = accountPath(c, poolList);

  const status = d?.status || "Unknown health";
  const kinds = entry?.serviceKinds?.length ? entry.serviceKinds : ["chat"];

  // ---- actions -----------------------------------------------------------
  const [action, setAction] = useState(null); // key of COPY
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [field, setField] = useState({});
  const thresholdWindows = [...new Set([
    ...(c?.lastQuotaSnapshot?.windows || []).map((window) => window.key),
    ...Object.keys(c?.quotaPauseThresholds || {}),
  ])].filter((key) => typeof key === "string" && key.length > 0);
  const [probe, setProbe] = useState(null);
  const validation = probe || d?.validation;
  const [grantStep, setGrantStep] = useState(null);

  function openAction(kind, seed = {}) {
    setRefused(null);
    setGrantStep(null);
    setField(seed);
    setAction(kind);
  }
  useEffect(() => { const clear = () => { if (document.hidden) setField(current => ({ ...current, secret: '', document: '', proxyUrl: '' })); }; document.addEventListener('visibilitychange', clear); return () => document.removeEventListener('visibilitychange', clear); }, []);
  const close = () => { setAction(null); setBusy(false); setRefused(null); setField({}); };

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
      case "pool": r = await call(`/api/providers/${id}`, { method: "PUT", body: field.poolId === '__legacy__' ? { connectionProxyEnabled: true, connectionProxyUrl: field.proxyUrl, connectionNoProxy: field.noProxy || '' } : { proxyPoolId: field.poolId === '__clear__' ? null : field.poolId || '__none__' } }); break;
      case "endpoint": r = await call(`/api/providers/${id}`, { method: "PUT", body: { baseUrl: field.baseUrl || "", ...(field.apiType ? { apiType: field.apiType } : {}) } }); break;
      case "concurrent": {
        const v = field.maxConcurrent === "" ? null : Number(field.maxConcurrent);
        r = await call("/api/settings", { method: "PATCH", body: { providerStrategyPatch: { providerId: c.provider, values: { maxConcurrent: v } } } });
        break;
      }
      case "recheck": {
        r = await call(`/api/admin/qualification/${id}/recheck`, { method: "POST", body: field.force ? { force: true } : {} });
        if (r.ok) setProbe(r.body.validation || null);
        break;
      }
      case "drain": r = await call(`/api/admin/drain/${id}`, { method: "POST", body: ver ? { ifMatch: ver } : {} }); break;
      case "undrain": r = await call(`/api/admin/drain/${id}?${new URLSearchParams(ver ? { ifMatch: ver } : {})}`, { method: "DELETE" }); break;
      case "reauth": {
        if (field.documentMode || (c.authType === 'oauth' && requiresCredentialDocument(c.provider))) {
          let body; try { body = credentialDocument(field.document, field.force); } catch (error) { r = { ok: false, status: 400, body: { error: error.message } }; break; }
          r = await call(`/api/providers/${id}/reauth`, { method: 'POST', body });
        } else if (!entry?.hasOAuth || c.authType === 'apikey' || c.authType === 'cookie') {
          r = await call(`/api/providers/${id}/reauth`, { method: "POST", body: { [c.authType === "cookie" ? "accessToken" : "apiKey"]: field.secret, ...(field.force ? { force: true } : {}) } });
        } else {
          const flowProbe = await call(`/api/oauth/${c.provider}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`);
          if (!flowProbe.ok) { r = flowProbe; break; }
          const kind = flowProbe.body.flowType;
          const reauth = { reauthConnectionId: id, ...(field.force ? { forceReauth: true } : {}) };
          const out = (kind === "browser_token" || kind === "import_token")
            ? await importPasted(c.provider, { token: field.secret, machineId: field.machineId ?? psd.machineId, reauth })
            : await runGrant(c.provider, kind, { reauth, report: setGrantStep, deviceOptions: psd, meta: psd });
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
    if (action === 'reauth' || action === 'pool') setField(current => ({ ...current, secret: '', document: '', proxyUrl: '' }));
    if (r.ok && action === 'reauth') {
      const read = await call(`/api/providers/${id}`);
      if (!read.ok || read.body?.connection?.id !== id || read.body.connection.provider !== c.provider) { setRefused({ tone: 'warn', title: 'Credential replacement was accepted, but the selected account could not be read back.', next: 'Close and refresh before another change.' }); return; }
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
          <h1 className="connection-name">{c ? <><ProviderMark provider={c.provider} />{c.name || c.displayName || c.email || c.provider}</> : "…"}</h1>
          {c ? <p className="caption"><span>{c.provider}</span> · {AUTH[c.authType] || c.authType}</p> : null}
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
              <dt>Signed in as</dt><dd>{c.email ? <span>{c.email}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Priority</dt><dd>{fmtNum(c.priority ?? 0)}</dd>
              <dt>Enabled</dt><dd>{c.isActive === false ? "No" : "Yes"}</dd>
              <dt>Created</dt><dd>{c.createdAt ? <span>{fmtTime(c.createdAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Updated</dt><dd>{c.updatedAt ? <span>{fmtTime(c.updatedAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
              <dt>Rate limited until</dt><dd>{c.rateLimitedUntil && !isEpoch(c.rateLimitedUntil) ? <span>{fmtTime(c.rateLimitedUntil)}</span> : <span>Not rate limited</span>}</dd>
              <dt>Default model</dt><dd>{c.defaultModel ? <span>{c.defaultModel}</span> : <span>Provider default</span>}</dd>
              <dt>Endpoint</dt><dd>{psd.baseUrl ? <span>{psd.baseUrl} ({psd.apiType || "chat"})</span> : <span>Provider default</span>}</dd>
              <dt>Proxy pool</dt><dd><bdi>{networkPath.label}</bdi></dd>
              <dt>Provider ceiling</dt><dd>{resolveProviderCeiling(settings.data, c.provider) !== null ? <span>{fmtNum(resolveProviderCeiling(settings.data, c.provider))}</span> : <span>No outer limit configured</span>}</dd>
              <dt>Account ceiling</dt><dd>{resolveAccountCapacity(c) === 0 ? <span>Explicitly unlimited</span> : <span>{fmtNum(resolveAccountCapacity(c))}{c.maxConcurrent == null ? " (default)" : ""}</span>}</dd>
            </dl>
            <p className="caption">{networkPath.policy} Pool binding stores its strictness on the account; pool edits update bound snapshots atomically.</p>
          </section>

          <section>
            <h2>Services</h2>
            <p className="caption">Service types registered for this provider. They describe the adapter, not this account&apos;s verified upstream entitlement.</p>
            <ul className="bullets">
              {kinds.map((k) => <li key={k}>{KIND_WORD[k] || k}</li>)}
            </ul>
          </section>

          <div className="verb-row"><AccountOptions connection={c} onSaved={() => { conn.refresh(); qual.refresh(); }} /><AccountOperations key={c.id} connection={c} onSaved={() => conn.refresh()} /></div>
          <AccountModelAccess connection={c} />

          <section>
            <h2>Last validation</h2>
            {qual.error && !d ? <Notice {...refusal(qual.status, qual.error)} /> : null}
            {d || probe ? (
              <dl className="facts">
                <dt>Verdict</dt><dd>{validation?.ok === true ? "Check passed" : validation?.ok === false ? "Check failed" : "Not established"}</dd>
                <dt>Generation</dt><dd className="unreported">Not verified by this check</dd>
                <dt>Model</dt><dd className="unreported">Not recorded</dd>
                <dt>Check duration</dt><dd>{typeof validation?.latencyMs === "number" ? <span>{fmtDuration(validation.latencyMs)}</span> : <span className="unreported">Not recorded</span>}</dd>
                <dt>Error</dt><dd>{validation?.error ? <span>{validation.error}</span> : <span className="unreported">Not recorded</span>}</dd>
                <dt>Observed</dt><dd>{validation?.checkedAt ? <span>{fmtRelative(validation.checkedAt, now)}</span> : <span className="unreported">Not recorded</span>}</dd>
              </dl>
            ) : !qual.error ? <p className="empty">No validation on record.</p> : null}
            <p className="caption">Provider checks differ. A local credential check, upstream authentication and a successful model request are separate evidence.</p>
            <div className="actions">
              <button type="button" className="button quiet" onClick={() => openAction("recheck", { force: false })}><Icon name="i-test" />Recheck</button>
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

          <section className="panel">
            <h2>Actions</h2>
            <div className="verb-row">
              {c.isActive === false
                ? <button type="button" className="button" onClick={() => openAction("enable")}><Icon name="i-play" />Enable</button>
                : <button type="button" className="button" onClick={() => openAction("disable")}><Icon name="i-pause" />Disable</button>}
              {drainState?.isDraining
                ? <button type="button" className="button quiet" onClick={() => openAction("undrain")}><Icon name="i-play" />Cancel the drain</button>
                : <button type="button" className="button quiet" onClick={() => openAction("drain")}><Icon name="i-drain" />Drain</button>}
              <button type="button" className="button quiet" onClick={() => openAction("reauth", { force: false, secret: "", machineId: "" })}><Icon name="i-lock" />Replace the credential</button>
              <button type="button" className="button danger" onClick={() => openAction("del")}><Icon name="i-delete" />Delete</button>
            </div>
            <details className="fold">
              <summary>Tuning</summary>
              <div className="verb-row">
                <button type="button" className="button quiet" onClick={() => openAction("priority", { priority: String(c.priority ?? 1) })}><Icon name="i-edit" />Priority</button>
                <button type="button" className="button quiet" onClick={() => openAction("thresholds", { ...(c.quotaPauseThresholds || {}) })}><Icon name="i-edit" />Pause thresholds</button>
                <button type="button" className="button quiet" onClick={() => openAction("pool", { poolId: psd.proxyPoolId || "" })}><Icon name="i-network" />Proxy pool</button>
                <button type="button" className="button quiet" onClick={() => openAction("endpoint", { baseUrl: psd.baseUrl || "", apiType: psd.apiType || "" })}><Icon name="i-send" />Endpoint</button>
                <button type="button" className="button quiet" onClick={() => openAction("concurrent", { maxConcurrent: maxConcurrent === undefined ? "" : String(maxConcurrent) })}><Icon name="i-shaping" />Concurrency ceiling</button>
              </div>
            </details>
            {drainState?.isDraining ? (
              <p className="caption">Draining since <span>{drainState.requestedAt ? fmtTime(drainState.requestedAt) : "—"}</span>, <span>{fmtNum(drainState.activeStreams)}</span> observed pending requests. Process counters can expire or lag; they do not establish whether a response is still streaming.</p>
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
            {thresholdWindows.map((scope) => (
              <label className="field" key={scope}>
                <span>{scope}</span>
                <input className="input" type="number" min="0" max="100" placeholder="No pause"
                  value={field[scope] ?? ""} onChange={(e) => setField((f) => ({ ...f, [scope]: e.target.value }))} />
              </label>
            ))}
            {!thresholdWindows.length && <p className="empty">No exact quota windows have been observed or configured for this account. Threshold inputs will appear when a quota snapshot identifies its windows.</p>}
            <p className="caption">A positive threshold pauses at or below this percentage remaining. For example, 10 pauses at 10% remaining or less, after at least 90% has been used. Set 0 or leave empty to turn off pausing for that exact window. Unlimited windows and unknown remaining percentages do not trigger a pause.</p>
          </div>
        ) : null}
        {action === "pool" ? (
          <div className="connections-form"><label className="field"><span>Pool or account proxy</span>
            <select className="select" value={field.poolId ?? ""} onChange={(e) => setField((f) => ({ ...f, poolId: e.target.value }))}>
              <option value="">Explicit direct connection</option>
              <option value="__clear__">Clear pool; restore the retained account/global path</option>
              <option value="__legacy__">Custom proxy for this account</option>
              {poolList.filter((p) => p.isActive !== false).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <p className="caption">Clearing a pool preserves any existing explicit direct or custom proxy policy. A selected pool takes precedence over those retained settings.</p>
          {field.poolId === '__legacy__' ? <><label className="field"><span>Account proxy URL</span><input className="input" type="password" autoComplete="off" value={field.proxyUrl || ''} onChange={event => { const value = event.currentTarget.value; setField(current => ({ ...current, proxyUrl: value })); }} /></label><label className="field"><span>Bypass hosts</span><input className="input" value={field.noProxy || ''} onChange={event => { const value = event.currentTarget.value; setField(current => ({ ...current, noProxy: value })); }} /></label></> : null}
          </div>
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
          <label className="field"><span>Ceiling</span><input className="input" type="number" min="1" placeholder="No outer limit" value={field.maxConcurrent ?? ""} onChange={(e) => setField((f) => ({ ...f, maxConcurrent: e.target.value }))} /></label>
        ) : null}
        {action === "recheck" ? (
          <label className="connections-check"><input type="checkbox" checked={!!field.force} onChange={(e) => setField((f) => ({ ...f, force: e.target.checked }))} /><span>Force, even if a result is fresh</span></label>
        ) : null}
        {action === "reauth" ? (
          <div className="connections-form">
            <label className="connections-check"><input type="checkbox" checked={Boolean(field.documentMode || (c?.authType === 'oauth' && requiresCredentialDocument(c.provider)))} disabled={c?.authType === 'oauth' && requiresCredentialDocument(c.provider)} onChange={event => { const checked = event.currentTarget.checked; setField(value => ({ ...value, documentMode: checked, document: '', secret: '' })); }} /><span>Replace from a credential document</span></label>
            {field.documentMode || (c?.authType === 'oauth' && requiresCredentialDocument(c.provider)) ? <label className="field"><span>Credential JSON for this account</span><textarea className="input" autoComplete="off" value={field.document || ''} onChange={event => { const value = event.currentTarget.value; setField(current => ({ ...current, document: value })); }} /><span className="caption">One account document or an export containing exactly one account. This path preserves the selected account identity. Local callback sign-ins create new accounts and are not used for replacement.</span></label> : null}
            {!field.documentMode && (!entry?.hasOAuth || c?.authType === 'apikey' || c?.authType === 'cookie') ? (
              <label className="field"><span>{c?.authType === "cookie" ? "Cookie value" : "API key"}</span><input className="input" type="password" autoComplete="off" value={field.secret ?? ""} onChange={(e) => setField((f) => ({ ...f, secret: e.target.value }))} /></label>
            ) : null}
            {!field.documentMode && ['cursor', 'kimchi'].includes(c?.provider) && c?.authType !== 'apikey' ? <label className="field"><span>Pasted token</span><input className="input" type="password" autoComplete="off" value={field.secret ?? ''} onChange={event => setField(value => ({ ...value, secret: event.target.value }))} /></label> : null}
            {c?.provider === 'cursor' ? <label className="field"><span>Machine id</span><input className="input" value={field.machineId ?? psd.machineId ?? ''} onChange={event => setField(value => ({ ...value, machineId: event.target.value }))} /></label> : null}
            <label className="connections-check"><input type="checkbox" checked={!!field.force} onChange={(e) => setField((f) => ({ ...f, force: e.target.checked }))} /><span>Rebind even if the provider account differs</span></label>
            {grantStep ? <p className="caption">{grantStep}</p> : null}
          </div>
        ) : null}
        {action === "del" && c ? <p className="caption">{c.name || c.email || c.provider}</p> : null}
      </Confirm>
    </div>
  );
}
