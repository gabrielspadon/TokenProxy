"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePoll } from "@/shared/hooks/usePoll";
import { Freshness } from "@/shared/components/Freshness";
import { Notice } from "@/shared/components/Notice";
import { Confirm } from "@/shared/components/Confirm";
import { call } from "@/shared/api";
import { refusal } from "@/shared/refusal";
import { runGrant, importPasted } from "@/shared/oauthGrant";
import { TONE, WORDS, AUTH } from "@/shared/status";
import { fmtNum, fmtRelative, fmtTime } from "@/shared/format";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { Icon } from "@/shared/components/Icon";
import "./styles.css";

function pollFresh(p) {
  if (p.loading) return "connecting";
  if (p.error && p.goodAt) return "stale";
  if (p.error) return "reconnecting";
  return "live";
}

const RELEASE_WORD = { active: "Active", pending: "Pending", rolled_back: "Rolled back", failed: "Failed" };
const RELEASE_TONE = { active: "ok", pending: "warn", rolled_back: "warn", failed: "bad" };
const CAUSE_WORD = {
  cooldown: "cooling down after a rate limit",
  drained: "drained",
  probe_failed: "a failed probe",
  token_expired: "an expired credential",
  error: "a recorded error",
};

// How a provider entry can be credentialed, derived from the registry entry.
function modesOf(entry) {
  const modes = [];
  if (entry.hasOAuth) modes.push("oauth");
  if (entry.noAuth) modes.push("none");
  else if (entry.authType === "cookie") modes.push("cookie");
  else modes.push("apikey");
  return modes;
}

const MODE_WORD = { oauth: "OAuth grant", apikey: "API key", cookie: "Cookie", none: "No credential", paste: "Pasted token" };

export default function ConnectionsPage() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const providers = usePoll("/api/providers", 10000);
  const qual = usePoll("/api/admin/qualification", 10000);
  const drain = usePoll("/api/admin/drain?all=true", 10000);
  const sys = usePoll("/api/system/state?windowSeconds=3600", 30000);
  const activation = usePoll("/api/admin/activation", 30000);

  const [q, setQ] = useState("");
  const [only, setOnly] = useState("all");

  const byQual = useMemo(() => {
    const m = new Map();
    for (const c of qual.data?.connections || []) m.set(c.connectionId, c);
    return m;
  }, [qual.data]);
  const byDrain = useMemo(() => {
    const m = new Map();
    for (const d of drain.data?.connections || []) m.set(d.connectionId, d);
    return m;
  }, [drain.data]);

  const rows = useMemo(() => {
    const list = (providers.data?.connections || []).map((c) => {
      const s = byQual.get(c.id);
      return {
        id: c.id,
        provider: c.provider,
        name: c.name || c.displayName || c.email || c.id,
        email: c.email || null,
        authType: c.authType,
        priority: c.priority,
        isActive: c.isActive !== false,
        status: s?.status || (c.isActive === false ? "unqualified" : "healthy"),
        isDraining: byDrain.get(c.id)?.isDraining === true,
        lastQualifiedAt: s?.lastQualifiedAt || null,
        lastError: s?.lastError || null,
      };
    });
    const needle = q.trim().toLowerCase();
    return list
      .filter((r) => !needle || r.provider.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
      .filter((r) => only === "all" || (only === "degraded" ? r.status !== "healthy" : r.status === only))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.provider.localeCompare(b.provider));
  }, [providers.data, byQual, byDrain, q, only]);

  const all = providers.data?.connections || [];
  const enabled = all.filter((c) => c.isActive !== false).length;
  const draining = all.filter((c) => byDrain.get(c.id)?.isDraining === true).length;
  const health = sys.data?.providerHealth || null;

  // ---- add flow ----------------------------------------------------------
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ providerId: "", mode: "", name: "", secret: "", machineId: "" });
  const [flow, setFlow] = useState(null); // authorize probe result for OAuth providers
  const [grant, setGrant] = useState(null); // {step} | {device} | {connection}
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const abortRef = useRef(null);

  const entries = useMemo(
    () => Object.values(AI_PROVIDERS).filter((p) => !p.hidden).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [],
  );
  const entry = form.providerId ? AI_PROVIDERS[form.providerId] : null;
  const modes = entry ? modesOf(entry) : [];

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function pickProvider(id) {
    setForm({ providerId: id, mode: "", name: "", secret: "", machineId: "" });
    setFlow(null);
    setRefused(null);
    const e = AI_PROVIDERS[id];
    if (!e) return;
    const m = modesOf(e);
    set("mode", m[0]);
    if (e.hasOAuth) {
      const r = await call(`/api/oauth/${id}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`);
      if (r.ok) setFlow(r.body);
      else setFlow({ failed: refusal(r.status, r.body) });
    }
  }

  function closeAdd() {
    abortRef.current?.abort();
    setAdding(false);
    setGrant(null);
    setRefused(null);
    setBusy(false);
  }

  async function runAdd() {
    if (grant?.connection) { closeAdd(); return; }
    setBusy(true);
    setRefused(null);
    let out;
    if (form.mode === "oauth") {
      if (flow?.failed) { setRefused(flow.failed); setBusy(false); return; }
      const kind = flow?.flowType || "authorization_code";
      if (kind === "browser_token" || kind === "import_token") {
        out = await importPasted(form.providerId, { token: form.secret, machineId: form.machineId });
      } else {
        const ac = new AbortController();
        abortRef.current = ac;
        out = await runGrant(form.providerId, kind, {
          signal: ac.signal,
          report: (step) => setGrant((g) => ({ ...(g || {}), step })),
          deviceHook: (device) => setGrant((g) => ({ ...(g || {}), device })),
        });
      }
    } else {
      out = await call("/api/providers", {
        method: "POST",
        body: {
          provider: form.providerId,
          name: form.name,
          ...(form.mode === "none" ? {} : { apiKey: form.secret }),
        },
      });
      out = out.ok ? { ok: true, connection: out.body.connection } : { ok: false, status: out.status, body: out.body };
    }
    setBusy(false);
    if (out.ok) {
      setGrant({ connection: out.connection });
      providers.refresh();
      qual.refresh();
    } else {
      setRefused(refusal(out.status, out.body));
    }
  }

  // ---- releases ----------------------------------------------------------
  const [releaseAct, setReleaseAct] = useState(null); // {kind:"activate", release} | {kind:"rollback"}
  const [relBusy, setRelBusy] = useState(false);
  const [relRefused, setRelRefused] = useState(null);
  const active = activation.data?.active || null;
  const history = activation.data?.history || [];

  async function runRelease() {
    setRelBusy(true);
    setRelRefused(null);
    const ifMatch = active?.concurrencyVersion;
    const r = releaseAct.kind === "activate"
      ? await call("/api/admin/activation", { method: "POST", body: { releaseId: releaseAct.release.releaseId, ...(ifMatch ? { ifMatch } : {}) } })
      : await call("/api/admin/rollback", { method: "POST", body: ifMatch ? { ifMatch } : {} });
    setRelBusy(false);
    if (r.ok) {
      setReleaseAct(null);
      activation.refresh();
    } else {
      setRelRefused(refusal(r.status, r.body));
    }
  }

  const firstError = providers.error || qual.error;
  const forbidden = firstError && (qual.status === 401 || qual.status === 403 || providers.status === 401);

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Connections</h1>
          <p className="caption">Every stored account, its standing in the fallback order, and the releases that route them.</p>
        </div>
        <div className="actions">
          <Freshness status={pollFresh(qual)} lastDataAt={qual.goodAt} />
          <button type="button" className="button" onClick={() => { setAdding(true); setForm({ providerId: "", mode: "", name: "", secret: "", machineId: "" }); setFlow(null); setGrant(null); }}><Icon name="i-add" />Add a connection</button>
        </div>
      </header>

      {forbidden ? <Notice {...refusal(qual.status || providers.status, qual.error || providers.error)} /> : null}

      <div className="measures">
        <div className="measure big"><span className="label">Configured</span><span className="value" data-i18n-skip>{fmtNum(all.length)}</span></div>
        <div className="measure big"><span className="label">Enabled</span><span className="value" data-i18n-skip>{fmtNum(enabled)}</span></div>
        <div className="measure big"><span className="label">Draining</span><span className="value" data-i18n-skip>{fmtNum(draining)}</span></div>
        <div className="measure big">
          <span className="label">Degraded providers</span>
          {health && health.unavailable === null ? <span className="value" data-i18n-skip>{fmtNum(health.degradedProviderCount)}</span> : <span className="value unreported">Not reported</span>}
        </div>
      </div>

      {health?.degradedProviders?.length ? (
        <Notice tone="warn" title="Some providers are degraded.">
          <ul className="bullets">
            {health.degradedProviders.map((d) => (
              <li key={d.provider}>
                <span data-i18n-skip>{d.provider}</span>: <span data-i18n-skip>{fmtNum(d.degradedConnections)}</span> degraded, likely {d.likelyCauses.map((c) => CAUSE_WORD[c] || c).join(", ")}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="toolbar">
        <label className="field"><span>Filter</span><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="field"><span>Show</span>
          <select className="select" value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="all">Everything</option>
            <option value="healthy">Healthy</option>
            <option value="degraded">Not healthy</option>
            <option value="cooldown">Cooling down</option>
            <option value="drained">Drained</option>
            <option value="unqualified">Unqualified</option>
          </select>
        </label>
      </div>

      {providers.loading ? <div className="skeleton" aria-hidden="true" /> : null}
      {!providers.loading && all.length === 0 && !firstError ? (
        <div className="empty">
          <p>No connections yet. Add one and the gateway can start routing.</p>
        </div>
      ) : null}

      <div className="rows">
        {rows.length ? (
          <div className="row head connections-row" aria-hidden="true">
            <span>Account</span><span>Standing</span><span>Last qualified</span>
          </div>
        ) : null}
        {rows.map((r) => (
          <div className="row connections-row" key={r.id}>
            <div className="who">
              <Link prefetch={false} href={`/dashboard/connections/${r.id}`} className="name" data-i18n-skip>{r.name}</Link>
              <span className="sub"><span data-i18n-skip>{r.provider}</span> · {AUTH[r.authType] || r.authType} · priority <span data-i18n-skip>{fmtNum(r.priority ?? 0)}</span></span>
            </div>
            <div>
              <span className="status" data-tone={TONE[r.status] || "warn"}>{WORDS[r.status] || r.status}</span>
              {r.isDraining ? <span className="status" data-tone="warn">Draining</span> : null}
              {!r.isActive ? <span className="caption">Disabled</span> : null}
            </div>
            <div>
              {r.lastQualifiedAt ? <span data-i18n-skip>{fmtRelative(r.lastQualifiedAt, now)}</span> : <span className="unreported">Never</span>}
              {r.lastError ? <p className="caption" data-i18n-skip>{r.lastError}</p> : null}
            </div>
          </div>
        ))}
      </div>

      <section className="connections-releases">
        <h2>Releases</h2>
        <p className="caption">Which build of the routing table is live. Activating another one changes how every request routes.</p>
        {activation.error ? <Notice {...refusal(activation.status, activation.error)} /> : null}
        {active ? (
          <dl className="facts">
            <dt>Active release</dt><dd data-i18n-skip>{active.releaseId}</dd>
            <dt>Version</dt><dd data-i18n-skip>{active.version}</dd>
            <dt>Activated</dt><dd>{active.activatedAt ? <span data-i18n-skip>{fmtTime(active.activatedAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
            <dt>Rolls back to</dt><dd>{active.previousReleaseId ? <span data-i18n-skip>{active.previousReleaseId}</span> : <span>Nothing on file</span>}</dd>
          </dl>
        ) : activation.data ? <p className="empty">No release is active.</p> : null}
        <div className="rows">
          {history.filter((h) => h.releaseId !== active?.releaseId).map((h) => (
            <div className="row" key={h.releaseId}>
              <div className="who">
                <span className="name" data-i18n-skip>{h.releaseId}</span>
                <span className="sub" data-i18n-skip>{h.version}</span>
              </div>
              <span className="status" data-tone={RELEASE_TONE[h.status] || "warn"}>{RELEASE_WORD[h.status] || h.status}</span>
              <div className="actions">
                <button type="button" className="button quiet" onClick={() => { setRelRefused(null); setReleaseAct({ kind: "activate", release: h }); }}><Icon name="i-play" />Activate</button>
              </div>
            </div>
          ))}
        </div>
        {active?.previousReleaseId ? (
          <div className="actions">
            <button type="button" className="button quiet" onClick={() => { setRelRefused(null); setReleaseAct({ kind: "rollback" }); }}><Icon name="i-refresh" mirror />Roll back</button>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Not reported by the gateway</h2>
        <ul className="bullets">
          <li>The per-connection concurrency ceiling. Only a per-provider ceiling exists, set from the connection screen.</li>
          <li>Which models are locked on a connection right now.</li>
          <li>Whether a quota pause is holding a connection out of rotation at this moment.</li>
          <li>Reordering the fallback list in one move. Priority is written one connection at a time.</li>
        </ul>
      </section>

      <Confirm open={adding} busy={busy} refusal={refused}
        title={grant?.connection ? "Connected" : "Add a connection"}
        verb={grant?.connection ? "Done" : form.mode === "oauth" ? "Sign in" : "Add"}
        requires={form.mode === "oauth" ? "An operator session, and finishing the provider's own sign-in." : "An operator session, and the credential to store."}
        changes="A new account joins the fallback order at its priority and can start receiving traffic."
        undo="Delete the connection. The stored credential is destroyed with it."
        onConfirm={runAdd} onClose={closeAdd}>
        {grant?.connection ? (
          <Notice tone="ok" title="The account is stored.">
            {grant.connection.email ? <p className="caption" data-i18n-skip>{grant.connection.email}</p> : null}
          </Notice>
        ) : (
          <div className="connections-form">
            <label className="field">
              <span>Provider</span>
              <select className="select" value={form.providerId} onChange={(e) => pickProvider(e.target.value)}>
                <option value="">Pick one</option>
                {entries.map((p) => <option key={p.id} value={p.id} data-i18n-skip>{p.name || p.id}</option>)}
              </select>
            </label>
            {entry && modes.length > 1 ? (
              <fieldset className="segmented">
                <legend>Credential</legend>
                {modes.map((m) => (
                  <label key={m}><input type="radio" name="mode" checked={form.mode === m} onChange={() => set("mode", m)} /><span>{MODE_WORD[m]}</span></label>
                ))}
              </fieldset>
            ) : null}
            {entry && form.mode !== "oauth" ? (
              <>
                <label className="field"><span>Name</span><input className="input" type="text" value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
                {form.mode !== "none" ? (
                  <label className="field">
                    <span>{form.mode === "cookie" ? "Cookie value" : "API key"}</span>
                    <input className="input" type="password" autoComplete="off" value={form.secret} onChange={(e) => set("secret", e.target.value)} />
                  </label>
                ) : null}
              </>
            ) : null}
            {entry && form.mode === "oauth" && flow?.failed ? <Notice {...flow.failed} /> : null}
            {entry && form.mode === "oauth" && (flow?.flowType === "browser_token" || flow?.flowType === "import_token") ? (
              <>
                <label className="field"><span>Pasted token</span><input className="input" type="password" autoComplete="off" value={form.secret} onChange={(e) => set("secret", e.target.value)} /></label>
                {form.providerId === "cursor" ? (
                  <label className="field"><span>Machine id</span><input className="input" type="text" value={form.machineId} onChange={(e) => set("machineId", e.target.value)} /></label>
                ) : null}
              </>
            ) : null}
            {grant?.device ? (
              <Notice tone="info" title="Enter this code with the provider.">
                <p><code data-i18n-skip>{grant.device.userCode}</code> at <a href={grant.device.verificationUri} target="_blank" rel="noreferrer" data-i18n-skip>{grant.device.verificationUri}</a></p>
              </Notice>
            ) : null}
            {grant?.step ? <p className="caption">{grant.step}</p> : null}
          </div>
        )}
      </Confirm>

      <Confirm open={!!releaseAct} busy={relBusy} refusal={relRefused}
        title={releaseAct?.kind === "activate" ? "Activate a release" : "Roll back"}
        verb={releaseAct?.kind === "activate" ? "Activate" : "Roll back"}
        requires="An operator session from this machine, and the release record unchanged since this screen read it."
        changes={releaseAct?.kind === "activate"
          ? "Routing switches to the chosen release for every request from that moment."
          : "Routing returns to the previous release for every request from that moment."}
        undo="Activate the other release again. Requests already routed stay routed."
        onConfirm={runRelease} onClose={() => setReleaseAct(null)}>
        {releaseAct?.kind === "activate" ? <p className="caption" data-i18n-skip>{releaseAct.release.releaseId}</p> : null}
      </Confirm>
    </div>
  );
}
