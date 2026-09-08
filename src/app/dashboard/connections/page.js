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
import { ProviderMark } from '@/shared/components/ProviderMark';
import { Icon } from "@/shared/components/Icon";
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { accountPath } from '../network/accountPath';
import ProviderImports from './ProviderImports';
import ProviderControls from './ProviderControls';
import KiroSocial from './KiroSocial';
import { ProviderOptionInputs, accountOptionFields, buildAccountOptions } from './AccountOptions';
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
  if (Array.isArray(entry.authModes) && entry.authModes.length) return entry.authModes;
  const modes = [];
  if (entry.hasOAuth) modes.push("oauth");
  if (entry.noAuth) modes.push("none");
  else if (entry.authType === "cookie") modes.push("cookie");
  else modes.push("apikey");
  return modes;
}

const MODE_WORD = { oauth: "OAuth grant", apikey: "API key", cookie: "Cookie", none: "No credential", paste: "Pasted token" };

function accountInvestigationHref(path, account, workspace) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(workspace?.scope || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  query.set('provider', account.provider);
  query.set('connectionId', account.id);
  query.set('selected', JSON.stringify({ kind: 'account', id: account.id, connectionId: account.id, provider: account.provider }));
  if (workspace?.comparisonIds?.length) query.set('compare', workspace.comparisonIds.join(','));
  return `${path}?${query}`;
}

export default function ConnectionsPage() {
  const workspace = useOptionalWorkspace();
  const scopedProvider = workspace?.scope.provider;
  const scopedAccountId = workspace?.scope.connectionId;
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
  const pools = usePoll('/api/proxy-pools', 30000);
  const nodes = usePoll('/api/provider-nodes', 30000);
  const [localSelectedId, setLocalSelectedId] = useState(null);
  const selectedId = workspace ? workspace.selectedRecord?.kind === 'account' ? workspace.selectedRecord.id : null : localSelectedId;
  const setSelectedId = (id) => {
    if (workspace) {
      const account = providers.data?.connections?.find(connection => connection.id === id);
      workspace.setSelectedRecord(id ? { kind: 'account', id, connectionId: id, ...(account?.provider ? { provider: account.provider } : {}) } : null);
    } else setLocalSelectedId(id);
  };

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
        status: s?.status || null,
        isDraining: byDrain.get(c.id)?.isDraining === true,
        lastQualifiedAt: s?.lastQualifiedAt || null,
        lastError: s?.lastError || null,
      };
    });
    const needle = q.trim().toLowerCase();
    return list
      .filter((r) => (!scopedProvider || r.provider === scopedProvider) && (!scopedAccountId || r.id === scopedAccountId))
      .filter((r) => !needle || [r.provider, r.name, r.email, r.id].some(value => value?.toLowerCase().includes(needle)))
      .filter((r) => only === 'all' || (only === 'degraded' ? ['degraded', 'cooldown', 'error', 'unavailable'].includes(r.status) : only === 'unknown' ? !r.status : only === 'drained' ? r.isDraining : only === 'disabled' ? !r.isActive : r.status === only))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.provider.localeCompare(b.provider));
  }, [providers.data, byQual, byDrain, q, only, scopedProvider, scopedAccountId]);

  const all = providers.data?.connections || [];
  const selected = all.find(connection => connection.id === selectedId);
  const selectedQualification = selected ? byQual.get(selected.id) : null;
  const selectedPath = selected ? accountPath(selected, pools.data?.proxyPools || []) : null;
  const enabled = all.filter((c) => c.isActive !== false).length;
  const draining = all.filter((c) => byDrain.get(c.id)?.isDraining === true).length;
  const health = sys.data?.providerHealth || null;

  // ---- add flow ----------------------------------------------------------
  const [task, setTask] = useState('accounts');
  const [reviewAdd, setReviewAdd] = useState(false);
  const [addUncertain, setAddUncertain] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  useEffect(() => {
    const readTask = () => { if (window.location.hash === '#provider-policy') setTask('provider-policy'); };
    readTask(); window.addEventListener('hashchange', readTask);
    return () => window.removeEventListener('hashchange', readTask);
  }, []);
  const [form, setForm] = useState({ providerId: "", mode: "", name: "", secret: "", machineId: "" });
  const [flow, setFlow] = useState(null); // authorize probe result for OAuth providers
  const [grant, setGrant] = useState(null); // {step} | {device} | {connection}
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const abortRef = useRef(null);
  const providerChoice = useRef(0);

  useEffect(() => { const clear = () => { if (document.hidden) setForm(current => ({ ...current, secret: '', clientSecret: '', customHeaders: '', managementKey: '' })); }; document.addEventListener('visibilitychange', clear); return () => { abortRef.current?.abort(); document.removeEventListener('visibilitychange', clear); }; }, []);

  const entries = useMemo(
    () => [...Object.values(AI_PROVIDERS), ...(nodes.data?.nodes || []).map(node => ({ ...node, authModes: ['apikey'], acceptsEmptyKey: node.type !== 'custom-embedding' }))]
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [nodes.data],
  );
  const entry = entries.find(candidate => candidate.id === form.providerId);
  const modes = entry ? modesOf(entry) : [];

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function pickProvider(id) {
    const choice = ++providerChoice.current;
    setForm({ providerId: id, mode: "", name: "", secret: "", machineId: "" });
    setFlow(null);
    setRefused(null);
    const e = entries.find(candidate => candidate.id === id);
    if (!e) return;
    const m = modesOf(e);
    set("mode", m[0]);
    if (e.hasOAuth) {
      const r = await call(`/api/oauth/${id}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`);
      if (choice !== providerChoice.current) return;
      if (r.ok) setFlow(r.body);
      else setFlow({ failed: refusal(r.status, r.body) });
    }
  }

  function closeAdd() {
    providerChoice.current++;
    abortRef.current?.abort();
    setReviewAdd(false);
    setAddUncertain(false);
    setGrant(null);
    setRefused(null);
    setBusy(false);
    setForm({ providerId: '', mode: '', name: '', secret: '', machineId: '' });
  }

  async function runAdd() {
    const choice = providerChoice.current;
    if (grant?.connection) { closeAdd(); return; }
    setBusy(true);
    setRefused(null);
    if (!entry || !modes.includes(form.mode)) {
      setRefused({ tone: 'bad', title: 'Choose a supported provider and authentication method.' });
      setBusy(false); return;
    }
    if (form.mode === 'none') {
      setRefused({ tone: 'info', title: 'This provider uses a virtual account.', next: 'No credential is stored. Use its provider controls below to enable it, or Network to choose its outbound path.' });
      setBusy(false); return;
    }
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
          deviceOptions: form,
          meta: { baseUrl: form.baseUrl, clientId: form.clientId, clientSecret: form.clientSecret },
          signal: ac.signal,
          report: (step) => { if (choice === providerChoice.current) setGrant((g) => ({ ...(g || {}), step })); },
          deviceHook: (device) => { if (choice === providerChoice.current) setGrant((g) => ({ ...(g || {}), device })); },
        });
      }
    } else {
      let options; try { options = buildAccountOptions({ ...form, name: form.name || entry.name || entry.id, defaultModel: form.defaultModel || '', globalPriority: '', maxConcurrent: '' }, accountOptionFields(form.providerId)); }
      catch (error) { setBusy(false); setRefused({ tone: 'bad', title: error.message }); return; }
      out = await call("/api/providers", {
        method: "POST",
        body: {
          provider: form.providerId,
          name: options.name,
          defaultModel: options.defaultModel,
          ...(options.providerSpecificData ? { providerSpecificData: options.providerSpecificData } : {}),
          ...(form.mode === "none" ? {} : { apiKey: form.secret }),
        },
      });
      out = out.ok ? { ok: true, connection: out.body.connection } : { ok: false, status: out.status, body: out.body };
    }
    if (choice !== providerChoice.current) return;
    setForm(current => ({ ...current, secret: '', clientSecret: '', customHeaders: '', managementKey: '' }));
    setBusy(false);
    if (out.ok) {
      const savedId = out.connection?.id;
      const read = savedId ? await call(`/api/providers/${encodeURIComponent(savedId)}`) : null;
      if (choice !== providerChoice.current) return;
      if (!read?.ok || read.body?.connection?.id !== savedId) { setBusy(false); setAddUncertain(true); setRefused({ tone: 'warn', title: 'The account write was accepted, but the saved account was not confirmed.', next: 'Close and refresh the account list before another import.' }); providers.refresh(); return; }
      setGrant({ connection: out.connection });
      providers.refresh();
      qual.refresh();
    } else {
      if (!out.status) setAddUncertain(true);
      setRefused(refusal(out.status, out.body));
    }
  }

  // ---- releases ----------------------------------------------------------
  const [releaseAct, setReleaseAct] = useState(null); // {kind:"activate", release} | {kind:"rollback"}
  const [restoreId, setRestoreId] = useState('');
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
      : await call("/api/admin/rollback", { method: "POST", body: { ...(ifMatch ? { ifMatch } : {}), ...(releaseAct.toReleaseId ? { toReleaseId: releaseAct.toReleaseId } : {}) } });
    if (r.ok) {
      const read = await call('/api/admin/activation');
      const verified = read.ok && read.body?.active?.releaseId === r.body?.releaseId && read.body?.active?.concurrencyVersion === r.body?.concurrencyVersion;
      if (!verified) { setRelRefused({ tone: 'warn', title: 'The release record was accepted, but its saved state was not confirmed.', next: 'Close and refresh before another change. This does not activate software or switch traffic.' }); return; }
      setRelBusy(false);
      setReleaseAct(null);
      activation.refresh();
    } else {
      setRelBusy(false);
      setRelRefused(refusal(r.status, r.body));
    }
  }

  const firstError = providers.error || qual.error;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Connections</h1>
          <p className="caption">Stored accounts, routing eligibility and recorded release history.</p>
        </div>
        <div className="actions">
          <Freshness status={pollFresh(qual)} lastDataAt={qual.goodAt} />
          <button type="button" className="button" disabled={busy || taskBusy} onClick={() => { setTask("add"); setForm({ providerId: "", mode: "", name: "", secret: "", machineId: "" }); setFlow(null); setGrant(null); }}><Icon name="i-add" />Add a connection</button>
        </div>
      </header>

      {[['Account inventory', providers], ['Qualification evidence', qual], ['Drain state', drain]].map(([label, resource]) => resource.error ? <div key={label}>
        <Notice {...(resource.status === 0 || resource.error.code === 'network'
          ? { tone: 'warn', title: `${label} could not be refreshed.`, next: resource.data ? 'Showing the last successful observation. Other account evidence is read independently.' : 'This evidence is unavailable. Retry this read; no provider probe will run.' }
          : refusal(resource.status, resource.error))} />
        <button type="button" className="button quiet" onClick={resource.refresh} disabled={resource.loading}>Retry {label.toLowerCase()}</button>
      </div> : null)}

      <nav className="verb-row" aria-label="Connection tasks">{[['accounts', 'Accounts'], ['add', 'Add account'], ['import', 'Import'], ['provider-policy', 'Provider policy'], ['kiro', 'Kiro sign-in']].map(([value, label]) => <button key={value} type="button" className={task === value ? 'button' : 'button quiet'} aria-pressed={task === value} disabled={busy || taskBusy} onClick={() => { if (task === 'add' && value !== 'add') closeAdd(); setTask(value); }}>{label}</button>)}</nav>
      {task === 'accounts' ? <>
      <dl className="connections-summary" aria-label="Connection status summary">
        <div><dt>Configured</dt><dd><bdi>{providers.data ? fmtNum(all.length) : 'Unknown'}</bdi></dd></div>
        <div><dt>Enabled</dt><dd><bdi>{providers.data ? fmtNum(enabled) : 'Unknown'}</bdi></dd></div>
        <div><dt>Draining</dt><dd><bdi>{drain.data ? fmtNum(draining) : 'Unknown'}</bdi></dd></div>
        <div><dt>Degraded providers</dt><dd><bdi>{health && health.unavailable === null ? fmtNum(health.degradedProviderCount) : 'Unknown'}</bdi></dd></div>
      </dl>

      {health?.degradedProviders?.length ? (
        <Notice tone="warn" title="Some providers are degraded.">
          <ul className="bullets">
            {health.degradedProviders.map((d) => (
              <li key={d.provider}>
                <span>{d.provider}</span>: <span>{fmtNum(d.degradedConnections)}</span> degraded, likely {d.likelyCauses.map((c) => CAUSE_WORD[c] || c).join(", ")}
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
            <option value="degraded">Observed unhealthy</option>
            <option value="unknown">Qualification unknown</option>
            <option value="cooldown">Cooling down</option>
            <option value="drained">Drained</option>
            <option value="disabled">Disabled</option>
            <option value="unqualified">Unqualified</option>
          </select>
        </label>
      </div>
      {workspace?.scope.provider || workspace?.scope.connectionId ? <p className="caption">Showing current accounts in the retained provider/account scope. <button type="button" className="link-button" onClick={() => workspace.setScope({ provider: null, connectionId: null })}>Show all accounts</button> The historical interval and model remain available when you return to analysis.</p> : null}

      {providers.loading ? <div className="skeleton" aria-hidden="true" /> : null}
      {!providers.loading && all.length === 0 && !firstError ? (
        <div className="empty">
          <p>No connections yet. Add one and the gateway can start routing.</p>
        </div>
      ) : null}
      {all.length > 0 && rows.length === 0 ? <div className="empty"><p>No accounts match these filters.</p><button type="button" className="button quiet" onClick={() => { setQ(''); setOnly('all'); workspace?.setScope({ provider: null, connectionId: null }); }}>Clear account filters</button></div> : null}
      {selected && !rows.some(row => row.id === selected.id) ? <p className="caption">The selected account is outside the displayed filters. Its evidence remains open.</p> : null}

      <SelectionDock open={!!selected} title={selected?.name || selected?.id} subtitle={selected?.provider} mark={selected ? <ProviderMark provider={selected.provider} /> : null} onClose={() => setSelectedId(null)} height="min(660px, calc(100dvh - 280px))" closedMaxHeight="min(660px, calc(100dvh - 280px))" detail={selected ? <div className="connections-inspector">
        <dl className="facts"><dt>Account ID</dt><dd><bdi>{selected.id}</bdi></dd><dt>Authentication</dt><dd>{AUTH[selected.authType] || selected.authType || 'Unknown'}</dd><dt>Qualification status</dt><dd>{WORDS[selectedQualification?.status] || selectedQualification?.status || 'Unknown'}<p className="caption">Qualification combines recorded validation with drain, active state and cooldown. It does not establish model eligibility.</p></dd><dt>Local participation</dt><dd>{selected.isActive === false ? 'Disabled' : byDrain.get(selected.id)?.isDraining ? 'Draining; no new work' : 'Enabled; model, quota and capacity restrictions still apply'}</dd><dt>Upstream model entitlement</dt><dd>Unknown. A stored account or health result does not establish model access.</dd><dt>Network path</dt><dd>{pools.data ? <><bdi>{selectedPath.label}</bdi>. {selectedPath.policy}</> : 'Pool inventory unavailable; path not verified.'}</dd></dl>
        <Link href={`/dashboard/connections/${encodeURIComponent(selected.id)}`} prefetch={false}>Configure account</Link>
        <h3>Investigate this account</h3>
        <p className="caption">Open the account’s recorded activity with the retained time range and model. Current configuration and historical activity remain separate.</p>
        <div className="verb-row">
          {[['Capacity', '/dashboard'], ['Context', '/dashboard/context'], ['Economics', '/dashboard/usage']].map(([label, path]) => <Link key={path} href={accountInvestigationHref(path, selected, workspace)} onClick={() => workspace?.setScope({ provider: selected.provider, connectionId: selected.id })}>{label}</Link>)}
        </div>
      </div> : null}>
      <div className="rows connections-inventory">
        {rows.length ? (
          <div className="row head connections-row" aria-hidden="true">
            <span>Account</span><span>Qualification</span><span>Last observed</span><span>Details</span>
          </div>
        ) : null}
        {rows.map((r) => (
          <div className="row connections-row" key={r.id} data-selected={selectedId === r.id}>
            <div className="who">
              <ProviderMark provider={r.provider}/>
              <div className="connection-copy">
                <Link prefetch={false} href={`/dashboard/connections/${r.id}`} className="name">{r.name}</Link>
                <span className="sub"><span>{r.provider}</span> · {AUTH[r.authType] || r.authType} · priority <span>{fmtNum(r.priority ?? 0)}</span></span>
              </div>
            </div>
            <div className="connection-standing">
              <span className="status" data-tone={TONE[r.status] || "neutral"}>{WORDS[r.status] || r.status || 'Qualification unknown'}</span>
              {r.isDraining ? <span className="status" data-tone="warn">Draining</span> : null}
              {!r.isActive ? <span className="caption">Disabled</span> : null}
            </div>
            <div>
              {r.lastQualifiedAt ? <span>{fmtRelative(r.lastQualifiedAt, now)}</span> : <span className="unreported">Not recorded</span>}
              {r.lastError ? <p className="caption">{r.lastError}</p> : null}
            </div>
            <div className="actions"><Link href={`/dashboard/connections/${encodeURIComponent(r.id)}`} prefetch={false}>Configure</Link>
            <button type="button" className="button quiet" aria-label={`Inspect account ${r.name}`} aria-pressed={selectedId === r.id} onClick={() => setSelectedId(r.id)}>Inspect account</button></div>
          </div>
        ))}
      </div>
      </SelectionDock>


      <section className="connections-releases">
        <h2>Release records</h2>
        <p className="caption">The recorded active release and its history. These controls update metadata; they do not deploy software or switch request routing.</p>
        {activation.error ? <Notice {...refusal(activation.status, activation.error)} /> : null}
        {active ? (
          <dl className="facts">
            <dt>Recorded active release</dt><dd>{active.releaseId}</dd>
            <dt>Version</dt><dd>{active.version}</dd>
            <dt>Recorded at</dt><dd>{active.activatedAt ? <span>{fmtTime(active.activatedAt)}</span> : <span className="unreported">Not recorded</span>}</dd>
            <dt>Rolls back to</dt><dd>{active.previousReleaseId ? <span>{active.previousReleaseId}</span> : <span>Nothing on file</span>}</dd>
          </dl>
        ) : activation.data ? <p className="empty">No active release is recorded.</p> : null}
        <div className="rows">
          {history.filter((h) => h.releaseId !== active?.releaseId).map((h) => (
            <div className="row" key={h.releaseId}>
              <div className="who">
                <span className="name">{h.releaseId}</span>
                <span className="sub">{h.version}</span>
              </div>
              <span className="status" data-tone={RELEASE_TONE[h.status] || "warn"}>{RELEASE_WORD[h.status] || h.status}</span>
              <div className="actions">
                <button type="button" className="button quiet" onClick={() => { setRelRefused(null); setReleaseAct({ kind: "activate", release: h }); }}><Icon name="i-play" />Record as active</button>
              </div>
            </div>
          ))}
        </div>
        {active && history.some(item => item.releaseId !== active.releaseId) ? (
          <div className="actions">
            <label className="field"><span>Release record</span><select className="select" value={restoreId} onChange={event => setRestoreId(event.currentTarget.value)}><option value="">Previous recorded release</option>{history.filter(item => item.releaseId !== active?.releaseId).map(item => <option key={item.releaseId} value={item.releaseId}>{item.version || item.releaseId}</option>)}</select></label>
            <button type="button" className="button quiet" onClick={() => { setRelRefused(null); setReleaseAct({ kind: "rollback", toReleaseId: restoreId }); }}><Icon name="i-refresh" mirror />Restore a record</button>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Routing constraints</h2>
        <ul className="bullets">
          <li>Independent account limits and an optional provider ceiling can both constrain new work. Open an account to inspect both.</li>
          <li><Link href="/dashboard">Capacity</Link> shows recorded model cooldowns and quota-threshold exclusions for the selected model. Reported provider health is separate from routing eligibility.</li>
          <li>Reordering the fallback list in one move. Priority is written one connection at a time.</li>
        </ul>
      </section>

      </> : null}
      {task === 'import' ? <ProviderImports onBusyChange={setTaskBusy} onSaved={() => providers.refresh()} /> : null}
      {task === 'provider-policy' ? <ProviderControls onBusyChange={setTaskBusy} nodes={nodes.data?.nodes || []} onSaved={() => providers.refresh()} /> : null}
      {task === 'kiro' ? <KiroSocial onBusyChange={setTaskBusy} onSaved={() => providers.refresh()} /> : null}
      {task === 'add' ? <section aria-label="Add a connection"><h2>Add a connection</h2>
        {refused ? <Notice {...refused} /> : null}
        <fieldset disabled={busy || addUncertain || reviewAdd}>
        {grant?.connection ? (
          <Notice tone="ok" title="The account is stored.">
            {grant.connection.email ? <p className="caption">{grant.connection.email}</p> : null}
          </Notice>
        ) : (
          <div className="connections-form">
            <label className="field">
              <span>Provider</span>
              <select className="select" disabled={busy} value={form.providerId} onChange={(e) => pickProvider(e.target.value)}>
                <option value="">Pick one</option>
                {entries.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
              </select>
            </label>
            {entry && modes.length > 1 ? (
              <fieldset className="segmented">
                <legend>Credential</legend>
                {modes.map((m) => (
                  <label key={m}><input type="radio" name="mode" disabled={busy} checked={form.mode === m} onChange={() => set("mode", m)} /><span>{MODE_WORD[m]}</span></label>
                ))}
              </fieldset>
            ) : null}
            {entry && form.mode !== "oauth" ? (
              <>
                <label className="field"><span>Name</span><input className="input" type="text" value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
                {form.mode !== "none" ? (
                  <label className="field">
                    <span>{form.mode === "cookie" ? "Cookie value" : entry.acceptsEmptyKey || entry.id === 'ollama-local' ? 'API key (optional)' : "API key"}</span>
                    <input className="input" type="password" autoComplete="off" value={form.secret} onChange={(e) => set("secret", e.target.value)} />
                  </label>
                ) : null}
                {form.providerId === 'vertex' ? <p className="caption">The credential field accepts a Vertex API key, service-account JSON, or authorized-user ADC JSON. Project and location are available under Provider options.</p> : null}
              </>
            ) : null}
            {entry && form.mode !== 'oauth' && form.mode !== 'none' ? <section aria-label="Provider options"><h3>Provider options</h3><ProviderOptionInputs provider={form.providerId} values={form} onChange={set} disabled={busy} /></section> : null}
            {entry && form.mode === "oauth" && flow?.failed ? <Notice {...flow.failed} /> : null}
            {entry && form.mode === 'none' ? <Notice tone="info" title="No saved credential is needed." next="This provider uses a virtual account. Its availability and outbound path are managed in provider controls and Network." /> : null}
            {form.mode === 'oauth' && form.providerId === 'kiro' ? <div className="connections-form">
              <label className="field"><span>Sign-in type</span><select className="select" value={form.authMethod || 'builder-id'} onChange={event => set('authMethod', event.target.value)}><option value="builder-id">AWS Builder ID</option><option value="idc">IAM Identity Center</option></select></label>
              <label className="field"><span>AWS region</span><input className="input" value={form.region || ''} placeholder="us-east-1" onChange={event => set('region', event.target.value)} /></label>
              {form.authMethod === 'idc' ? <label className="field"><span>Identity Center start URL</span><input className="input" type="url" value={form.startUrl || ''} onChange={event => set('startUrl', event.target.value)} /></label> : null}
            </div> : null}
            {form.mode === 'oauth' && form.providerId === 'gitlab' ? <div className="connections-form">
              <label className="field"><span>GitLab instance URL</span><input className="input" type="url" value={form.baseUrl || ''} placeholder="https://gitlab.com" onChange={event => set('baseUrl', event.target.value)} /></label>
              <label className="field"><span>Application client ID</span><input className="input" value={form.clientId || ''} onChange={event => set('clientId', event.target.value)} /></label>
              <label className="field"><span>Application secret (optional)</span><input className="input" type="password" autoComplete="off" value={form.clientSecret || ''} onChange={event => set('clientSecret', event.target.value)} /></label>
            </div> : null}
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
                <p><code>{grant.device.userCode}</code> at <a href={grant.device.verificationUri} target="_blank" rel="noreferrer">{grant.device.verificationUri}</a></p>
              </Notice>
            ) : null}
            {grant?.step ? <p className="caption">{grant.step}</p> : null}
          </div>
        )}
        </fieldset>
        <div className="verb-row"><button type="button" className="button quiet" disabled={busy} onClick={closeAdd}>Reset draft</button><button type="button" className="button" disabled={busy || addUncertain || !entry || (form.mode === 'oauth' && !flow)} onClick={() => grant?.connection ? closeAdd() : setReviewAdd(true)}>{grant?.connection ? 'Done' : form.mode === 'oauth' ? 'Review sign-in' : 'Review account'}</button></div>
      </section> : null}
      <Confirm open={reviewAdd} busy={busy || addUncertain || (form.mode === 'oauth' && !flow)} refusal={refused}
        title={grant?.connection ? 'Connected' : 'Add a connection'} verb={grant?.connection ? 'Done' : form.mode === 'oauth' ? 'Sign in' : 'Add'}
        requires={form.mode === 'oauth' ? "An operator session, and finishing the provider's own sign-in." : 'An operator session, and the credential to store.'}
        changes="A new account joins the fallback order at its priority and can start receiving traffic."
        undo="Delete the connection. The stored credential is destroyed with it."
        onConfirm={runAdd} onClose={() => { if (!busy) setReviewAdd(false); }}>
        <p>{entry?.name || entry?.id} · {form.name || 'Provider account'} · {MODE_WORD[form.mode]}</p>
        {grant?.connection ? <Notice tone="ok" title="The account is stored." /> : null}
        {grant?.device ? <Notice tone="info" title="Enter this code with the provider."><p><code>{grant.device.userCode}</code> at <a href={grant.device.verificationUri} target="_blank" rel="noreferrer">{grant.device.verificationUri}</a></p></Notice> : null}
        {grant?.step ? <p className="caption">{grant.step}</p> : null}
      </Confirm>

      <Confirm open={!!releaseAct} busy={relBusy} refusal={relRefused}
        title={releaseAct?.kind === "activate" ? "Record an active release" : "Restore a release record"}
        verb={releaseAct?.kind === "activate" ? "Record release" : "Restore record"}
        requires="An operator session from this machine, and the release record unchanged since this screen read it."
        changes={releaseAct?.kind === "activate"
          ? "Updates the recorded active release and its history. This does not deploy software or change request routing."
          : "Updates the recorded release pointer to the selected history entry. This does not restore software or change request routing."}
        undo="Record another known release. The history of this change remains."
        onConfirm={runRelease} onClose={() => setReleaseAct(null)}>
        {releaseAct?.kind === "activate" ? <p className="caption">{releaseAct.release.releaseId}</p> : null}
        {releaseAct?.kind === 'rollback' ? <p>Release record · {releaseAct.toReleaseId || 'Previous recorded release'}</p> : null}
      </Confirm>
    </div>
  );
}
