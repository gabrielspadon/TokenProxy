"use client";
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit } from '@/shared/format';
import { ShapingWorkbench } from './Workbench';
import { ControlInventory, SignedBytes } from './ControlInventory';
import { CONTROLS, THRESHOLDS, controlScope, configuredState, stageEvidence, thresholdPatch } from './controlCatalog';
import './styles.css';

const SERVICE = {
  start: {
    verb: 'Start',
    title: 'Start the compression service',
    changes:
      'Loads the module into this process. It installs the package first when it is missing and automatic install is on.',
    undo: 'Stop it again here.',
    done: 'Start finished.',
  },
  stop: {
    verb: 'Stop',
    title: 'Stop the compression service',
    changes:
      'Drops the loaded module, so new requests pass through uncompressed. A request already mid-transform finishes on the copy it holds.',
    undo: 'Start it again here.',
    done: 'Stop finished.',
  },
  restart: {
    verb: 'Restart',
    title: 'Restart the compression service',
    changes:
      'Unloads and reloads the module, picking up an upgraded install without restarting the gateway.',
    undo: 'None needed. Restart again if it comes back wrong.',
    done: 'Restart finished.',
  },
  install: {
    verb: 'Install',
    title: 'Install the compression service',
    changes:
      'Fetches the current version, discards the loaded copy and runs the health check. It overwrites any previous installation and can take minutes.',
    undo: 'None. The previous installation is gone. Install again to replace it.',
    irreversible: true,
    done: 'Install finished.',
  },
};

const DEPTHS = ['Controls', 'Recorded evidence', 'Profiles and comparison', 'Service'];
const REASONS = { epoch_boundary: 'Stable or unknown cache boundary', window_pressure: 'Below context-pressure threshold', no_backend: 'No compression sidecar', phantom: 'Reported reduction without corresponding body reduction' };
function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}
const numeric = value => Number.isFinite(value) ? fmtNum(value) : 'Not reported';

function ServiceDetails({ onAction, health }) {
  const status = usePoll('/api/pxpipe/status', 15000);
  const logs = usePoll('/api/pxpipe/logs?limit=20', 60000);
  return <section className="shaping-service" aria-labelledby="shaping-service-title">
    <div className="shaping-section-head"><h2 id="shaping-service-title">Visual compression service</h2><Freshness status={pollFresh(status)} lastDataAt={status.goodAt} /><button className="button quiet" type="button" onClick={status.refresh}>Refresh status</button></div>
    <p>PXPIPE runs inside the gateway process. Reading status does not install, load or test the module.</p>
    {status.error ? <Notice {...refusal(status.status, status.error)} /> : null}
    <dl className="shaping-service-facts">
      <div><dt>Installed</dt><dd>{!status.data ? 'Not reported' : status.data.installing ? 'Installing' : status.data.installed ? 'Installed' : 'Not installed'}{status.data?.version ? <code data-i18n-skip>{status.data.version}</code> : null}</dd></div>
      <div><dt>Loaded</dt><dd>{!status.data ? 'Not reported' : status.data.running ? 'Loaded' : 'Not loaded'}</dd></div>
      <div><dt>Policy</dt><dd>{!status.data ? 'Not reported' : status.data.enabled ? 'Allowed' : 'Switched off'}</dd></div>
      <div><dt>Local self-test</dt><dd>{health ? health.healthy ? 'Passing' : 'Failing' : 'Not run in this view'}</dd></div>
      <div><dt>Automatic install</dt><dd>{!status.data ? 'Not reported' : status.data.autoInstall ? 'On' : 'Off'}</dd></div>
      <div><dt>Package manager</dt><dd>{!status.data ? 'Not reported' : status.data.npmAvailable ? 'Available' : 'Not found'}</dd></div>
    </dl>
    <div className="actions">{Object.keys(SERVICE).map(id => <button key={id} type="button" className={id === 'install' ? 'button danger' : 'button quiet'} onClick={() => onAction({ ...SERVICE[id], url: `/api/pxpipe/${id}` })}>{SERVICE[id].verb}</button>)}<button type="button" className="button quiet" onClick={() => onAction({ title: 'Run the local compression check', verb: 'Run local check', changes: 'Loads the installed PXPIPE module and transforms synthetic local input. This can change the loaded state. It does not call a model provider.', undo: 'Stop the module here if it should remain unloaded.', url: '/api/pxpipe/health', health: true, done: 'Local check finished.' })}>Run local check</button></div>
    {health?.checks?.length ? <ul className="shaping-observations">{health.checks.map(check => <li key={check.id}><span>{check.label}</span><span>{check.ok ? 'Passing' : 'Failing'}</span>{check.detail ? <span data-i18n-skip>{check.detail}</span> : null}</li>)}</ul> : null}
    {health && !health.healthy ? <Notice tone="warn" title="The local self-test did not pass." detail={health.error} /> : null}
    {logs.data?.installLog ? <details className="shaping-technical"><summary>Installation log</summary><pre className="shaping-log" data-i18n-skip>{logs.data.installLog}</pre></details> : null}
  </section>;
}

function RecordedEvidence({ stats, period, onPeriod }) {
  const window = stats.data?.windows?.[period];
  const stageMap = window?.stages || {};
  const stages = [...new Set(CONTROLS.map(control => control.stage).filter(Boolean))];
  const timeline = (stats.data?.pxpipe?.timeline || []).filter(day => day.requests > 0);
  const disclosure = usePoll('/api/tool-disclosure/stats', 30000);
  const turns = Array.isArray(disclosure.data) ? disclosure.data : [];
  return <section className="shaping-recorded" aria-labelledby="shaping-recorded-title">
    <div className="shaping-section-head"><h2 id="shaping-recorded-title">Recorded stage evidence</h2><label>Event period<select className="input" value={period} onChange={event => onPeriod(event.target.value)}><option value="all">Retained history</option><option value="today">Today</option><option value="last7d">Last 7 days</option><option value="last30d">Last 30 days</option></select></label><Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} /></div>
    <p>Global aggregate events, unfiltered by account or model. One request can produce several stage records. Negative bytes mean reduction; positive bytes mean growth.</p>
    <div className="shaping-integrity-note">Byte coverage is shown per stage. A record without a byte measurement contributes no measurement; a measured zero remains zero. Stage deltas are not added into a pipeline total, token saving or cost saving.</div>
    {stats.error ? <Notice {...refusal(stats.status, stats.error)} /> : null}
    {stats.data && !Object.keys(stageMap).length ? <p className="shaping-empty">No stage records in this period. Evidence appears when an eligible request records a stage outcome.</p> : null}
    <div className="shaping-table-scroll"><table className="shaping-evidence-table"><thead><tr><th>Stage</th><th>Recorded delta</th><th>Applied records</th><th>Byte coverage</th></tr></thead><tbody>{stages.map(stage => {
      const evidence = stageEvidence(stageMap, stage);
      const name = CONTROLS.find(control => control.stage === stage)?.name;
      return <tr key={stage}><th>{name}<code data-i18n-skip>{stage}</code></th><td>{!evidence.measured ? <span className="unreported">{evidence.measuredRecords === 0 ? 'Not measured' : 'Not reported'}</span> : <SignedBytes value={evidence.delta} />}</td><td>{numeric(evidence.applied)}</td><td>{evidence.measuredRecords === null ? 'Unknown' : <><bdi dir="ltr" data-i18n-skip>{numeric(evidence.measuredRecords)} / {numeric(evidence.records)}</bdi> records</>}</td></tr>;
    })}</tbody></table></div>
    <details className="shaping-technical"><summary>Separate units and reporting limits</summary><dl className="shaping-service-facts"><div><dt>Tool result characters removed</dt><dd>{numeric(window?.charsReduced)}</dd></div><div><dt>Headroom reported token reduction</dt><dd>{numeric(window?.proxyTokensSaved)}</dd></div><div><dt>PXPIPE estimated token reduction</dt><dd>{numeric(window?.estTokensSaved)}</dd></div><div><dt>Recorded transform duration, mean</dt><dd>{Number.isFinite(window?.avgMs) ? fmtUnit(window.avgMs, 'millisecond') : 'Not reported'}</dd></div><div><dt>Errors</dt><dd>Not reported</dd></div></dl><p>Errors can bypass the event sink, so zero errors would not establish successful execution. Character counts, reported tokens, token estimates and serialized bytes describe different quantities.</p></details>
    <details className="shaping-technical"><summary>Compression estimates by day</summary><p>PXPIPE only, from its retained daily records. Estimates do not establish billed token or cost reductions.</p>{timeline.length ? <div className="shaping-table-scroll"><table className="shaping-evidence-table"><thead><tr><th>UTC date</th><th>Estimated token reduction</th><th>Compressed / recorded</th></tr></thead><tbody>{timeline.map(day => <tr key={day.date}><th data-i18n-skip>{day.date}</th><td>{numeric(day.tokensSavedEst)}</td><td>{numeric(day.compressed)} / {numeric(day.requests)}</td></tr>)}</tbody></table></div> : <p>No compressed request is recorded in the returned daily history.</p>}</details>
    <details className="shaping-technical"><summary>Recent compression attempts</summary>{stats.data?.pxpipe?.recent?.length ? <ul className="shaping-observations">{stats.data.pxpipe.recent.slice(0, 20).map((row, index) => <li key={`${row.ts}-${index}`}><span>{fmtRelative(new Date(row.ts).toISOString())}</span><span>{row.applied ? 'Applied' : 'Bypassed'}{row.reason ? ` (${REASONS[row.reason] || row.reason})` : ''}</span><span>{numeric(row.tokensSavedEst)} estimated tokens</span><span>{numeric(row.durationMs)} ms</span><span>{numeric(row.imageCount)} images</span></li>)}</ul> : <p>No recent compression attempt is available in this sample.</p>}</details>
    <details className="shaping-technical"><summary>Tool disclosure records</summary>{disclosure.error ? <Notice {...refusal(disclosure.status, disclosure.error)} /> : null}{turns.length ? <div className="shaping-table-scroll"><table className="shaping-evidence-table"><thead><tr><th>Observed</th><th>Disclosed / original tools</th><th>Held back</th></tr></thead><tbody>{turns.slice(0, 20).map((turn, index) => <tr key={`${turn.ts}-${index}`}><th>{fmtRelative(new Date(turn.ts).toISOString())}</th><td>{numeric(turn.after)} / {numeric(turn.before)}</td><td>{numeric(turn.stripped)}</td></tr>)}</tbody></table></div> : <p>No disclosure record is available in this sample.</p>}</details>
  </section>;
}

export default function ShapingPage() {
  const settings = usePoll('/api/settings', 30000);
  const stats = usePoll('/api/token-saver/stats?timelineDays=30&recentLimit=100', 15000);
  const [depth, setDepth] = useState('Controls');
  const [opened, setOpened] = useState(['Controls']);
  const [period, setPeriod] = useState('all');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState({});
  const [health, setHealth] = useState(null);
  const [serviceRevision, setServiceRevision] = useState(0);
  const s = settings.data;
  const stageMap = stats.data?.windows?.all?.stages || {};
  const enabled = s ? CONTROLS.filter(control => s[control.key] === true).length : null;
  const known = s ? CONTROLS.filter(control => configuredState(s, control) !== 'Unknown').length : 0;
  const recorded = Object.keys(stageMap).length;
  const chains = useMemo(() => Object.entries(s?.comboStrategies || {}).filter(([, value]) => value && Object.hasOwn(value, 'tokenSaver')).map(([name, value]) => ({ name, value: value.tokenSaver })), [s]);
  const patch = thresholdPatch(draft);
  function navigate(next) { setDepth(next); setOpened(previous => previous.includes(next) ? previous : [...previous, next]); }
  function close() { if (!busy) { setPending(null); setFailed(null); } }
  function toggle(control, on) {
    setFailed(null);
    setPending({ title: `${on ? 'Turn on' : 'Turn off'} ${control.name.toLowerCase()}`, verb: on ? 'Turn on' : 'Turn off', layer: control.name, changes: `${controlScope(control)}. New requests take this setting; a request already in flight retains its settings. ${on ? control.effect : control.override ? 'This control is disabled globally; a supported routing-plan override may still enable it.' : 'New requests skip this globally disabled control.'}`, undo: 'Restore the previous setting here. Already removed request content cannot be recovered by changing this setting.', body: { [control.key]: on }, done: `${control.name} saved and verified after refresh.` });
  }
  async function run() {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true); setFailed(null); setNotice(null);
    if (action.url) setHealth(null);
    const response = await call(action.url || '/api/settings', { method: action.url ? 'POST' : 'PATCH', ...(action.body ? { body: action.body } : {}) });
    const observedHealth = action.health ? response.body : response.body?.health;
    if (observedHealth && typeof observedHealth.healthy === 'boolean') { setHealth(observedHealth); setServiceRevision(value => value + 1); }
    if (!response.ok) { setFailed(refusal(response.status, response.body)); setBusy(false); return; }
    if (action.body) {
      const verification = await call('/api/settings');
      const verified = verification.ok && Object.entries(action.body).every(([key, value]) => verification.body?.[key] === value);
      setNotice(verified ? { tone: 'ok', title: action.done } : { tone: 'warn', title: 'Save accepted; refreshed settings could not be confirmed.', children: 'Refresh the settings and inspect the control before making another change.' });
      settings.refresh();
      if (verified && action.thresholds) setDraft({});
    } else { setNotice(observedHealth?.healthy === false ? { tone: 'warn', title: 'Operation finished, but the local self-test failed.', children: observedHealth.error } : { tone: 'ok', title: action.done }); setServiceRevision(value => value + 1); }
    setPending(null); setBusy(false);
  }
  function renderThresholds(stage) {
    const fields = THRESHOLDS.filter(field => field.stage === stage);
    return fields.length ? <details className="shaping-technical"><summary>Edit this stage’s thresholds</summary><div className="shaping-form">{fields.map(field => <label key={field.key} className="field"><span>{field.name}</span><input className="input" type="number" inputMode="numeric" min={field.min} max={field.max} step="1" value={draft[field.key] ?? s?.[field.key] ?? ''} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))} /><span className="shaping-caption">{field.unit}</span></label>)}</div></details> : null;
  }
  return <div className="shaping-page">
    <header className="shaping-page-head"><div><h1>Optimization</h1><p>Control what changes before a request reaches its provider.</p></div><Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} /></header>
    <div className="shaping-summary" aria-label="Optimization summary"><div><span>Configured on</span><strong>{enabled === null ? 'Unknown' : <bdi dir="ltr" data-i18n-skip>{fmtNum(enabled)} / {fmtNum(known)}</bdi>}</strong><span>Global controls, before plan overrides</span></div><div><span>Stages with records</span><strong>{stats.data ? fmtNum(recorded) : 'Unknown'}</strong><span>Retained history, coverage can be partial</span></div><div className="shaping-summary-note"><strong>Configuration is not execution</strong><span>Inspect request evidence to establish applicability, execution and measured change.</span><Link href="/dashboard/context">Open Context</Link></div></div>
    {settings.error ? <Notice {...refusal(settings.status, settings.error)} /> : null}
    {notice ? <div role="status"><Notice {...notice} /></div> : null}
    <nav className="shaping-depths" aria-label="Optimization views">{DEPTHS.map(item => <button type="button" key={item} aria-current={depth === item ? 'page' : undefined} onClick={() => navigate(item)}>{item}</button>)}</nav>
    <div hidden={depth !== 'Controls'}>
      {!s && settings.loading ? <p className="shaping-empty">Reading global settings.</p> : <ControlInventory settings={s} stageMap={stageMap} recent={stats.data?.recent || []} onToggle={toggle} renderThresholds={renderThresholds} onInvestigate={() => navigate('Profiles and comparison')} />}
      <details className="shaping-technical shaping-scope"><summary>Routing precedence and context-window policy</summary><p>Global settings are the baseline. The outermost routing-plan declaration wins; unspecified supported flags inherit global values. A plan can bypass shaping. Privacy, disclosure, memory controls, content-change permissions and adaptive cache lifetime remain global.</p>{chains.length ? <ul className="shaping-observations">{chains.map(chain => <li key={chain.name}><code data-i18n-skip>{chain.name}</code><code data-i18n-skip>{JSON.stringify(chain.value)}</code></li>)}</ul> : <p>No routing-plan shaping override is configured.</p>}<p>Context-window overrides and cascade routing have separate settings and are outside shaping profiles.</p><div className="shaping-next"><Link href="/dashboard/models">Open model and plan settings</Link><Link href="/dashboard/model-context">Edit context-window overrides</Link></div></details>
    </div>
    {opened.includes('Recorded evidence') ? <div hidden={depth !== 'Recorded evidence'}><RecordedEvidence stats={stats} period={period} onPeriod={setPeriod} /></div> : null}
    {opened.includes('Profiles and comparison') ? <div hidden={depth !== 'Profiles and comparison'}><ShapingWorkbench onSettingsChanged={settings.refresh} /></div> : null}
    {opened.includes('Service') ? <div hidden={depth !== 'Service'}><ServiceDetails key={serviceRevision} onAction={action => { setFailed(null); setPending(action); }} health={health} /></div> : null}
    {Object.keys(draft).length ? <div className="shaping-draft-bar"><span>{fmtNum(Object.keys(draft).length)} unsaved threshold changes</span>{!patch ? <span>Enter whole numbers within each field’s limits.</span> : null}<button type="button" className="button" disabled={!patch} onClick={() => { setFailed(null); setPending({ title: 'Save threshold changes', verb: 'Save thresholds', changes: 'New requests use these global thresholds. In-flight requests retain their settings.', undo: 'Restore the previous numbers here.', body: patch, thresholds: true, done: 'Thresholds saved and verified after refresh.' }); }}>Review threshold changes</button><button type="button" className="button quiet" onClick={() => setDraft({})}>Discard</button></div> : null}
    <Confirm open={!!pending} title={pending?.title} verb={pending?.verb} requires="A signed-in operator session on the gateway host." changes={pending?.changes} undo={pending?.undo} irreversible={pending?.irreversible} busy={busy} refusal={failed} onConfirm={run} onClose={close}>{pending?.layer ? <p>{pending.layer}</p> : null}{pending?.thresholds ? <dl className="shaping-control-facts">{Object.entries(pending.body).map(([key, value]) => <div key={key}><dt>{THRESHOLDS.find(field => field.key === key)?.name}</dt><dd>{numeric(s?.[key])} → {fmtNum(value)} {THRESHOLDS.find(field => field.key === key)?.unit}</dd></div>)}</dl> : null}</Confirm>
  </div>;
}
