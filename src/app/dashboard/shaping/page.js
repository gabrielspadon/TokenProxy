"use client";
import { useState } from 'react';
import { Checkbox, Tabs } from '@mantine/core';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit } from '@/shared/format';
import { ShapingWorkbench } from './Workbench';
import { PlanOverrides } from './PlanOverrides';
import { RuntimeSettings } from './RuntimeSettings';
import { SignedBytes } from './ControlInventory';
import { TokenSavings } from './TokenSavings';
import { CONFIGURATION_FIELDS, CONTROLS, THRESHOLDS, configurationPatch, controlLabel, controlScope, stageEvidence } from './controlCatalog';
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
      'Drops the currently loaded module. If visual compression is enabled, the next eligible request can load it again. Turn off the global control and any plan override to stop future compression. A transform already in flight finishes on its retained copy.',
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

const VIEWS = ['Everyday', 'Advanced', 'Plan overrides', 'Profiles and comparison', 'Services', 'Recorded evidence'];
const REASONS = { epoch_boundary: 'Stable or unknown cache boundary', window_pressure: 'Below context-pressure threshold', no_backend: 'No compression sidecar', phantom: 'Reported reduction without corresponding body reduction' };
function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}
const numeric = value => Number.isFinite(value) ? fmtNum(value) : 'Not reported';
const settingValue = value => value === null ? 'Runtime default' : value === undefined ? 'Not reported' : Array.isArray(value) ? value.join(', ') || 'None' : typeof value === 'number' ? fmtNum(value) : value;

function ServiceDetails({ onAction, health }) {
  const status = usePoll('/api/pxpipe/status', 15000);

  return <section className="shaping-service" aria-labelledby="shaping-service-title">
    <div className="shaping-section-head"><h2 id="shaping-service-title">Visual compression service</h2><Freshness status={pollFresh(status)} lastDataAt={status.goodAt} /><button className="button quiet" type="button" onClick={status.refresh}>Refresh status</button></div>
    <p>PXPIPE runs inside the gateway process. Reading status does not install, load or test the module.</p>
    {status.error ? <Notice {...refusal(status.status, status.error)} /> : null}
    <dl className="shaping-service-facts">
      <div><dt>Installed</dt><dd>{!status.data ? 'Not reported' : status.data.installing ? 'Installing' : status.data.installed ? 'Installed' : 'Not installed'}{status.data?.version ? <code>{status.data.version}</code> : null}</dd></div>
      <div><dt>Loaded</dt><dd>{!status.data ? 'Not reported' : status.data.running ? 'Loaded' : 'Not loaded'}</dd></div>
      <div><dt>Policy</dt><dd>{!status.data ? 'Not reported' : status.data.enabled ? 'Allowed' : 'Switched off'}</dd></div>
      <div><dt>Local self-test</dt><dd>{health ? health.healthy ? 'Passing' : 'Failing' : 'Not run in this view'}</dd></div>
      <div><dt>Automatic install</dt><dd>{!status.data ? 'Not reported' : status.data.autoInstall ? 'On' : 'Off'}</dd></div>
      <div><dt>Package manager</dt><dd>{!status.data ? 'Not reported' : status.data.npmAvailable ? 'Available' : 'Not found'}</dd></div>
    </dl>
    <div className="actions">{Object.keys(SERVICE).map(id => <button key={id} type="button" className={id === 'install' ? 'button danger' : 'button quiet'} onClick={() => onAction({ ...SERVICE[id], url: `/api/pxpipe/${id}` })}>{SERVICE[id].verb}</button>)}<button type="button" className="button quiet" onClick={() => onAction({ title: 'Run the local compression check', verb: 'Run local check', changes: 'Loads the installed PXPIPE module and transforms synthetic local input. This can change the loaded state. It does not call a model provider.', undo: 'Stop the module here if it should remain unloaded.', url: '/api/pxpipe/health', health: true, done: 'Local check finished.' })}>Run local check</button></div>
    {health?.checks?.length ? <ul className="shaping-observations">{health.checks.map(check => <li key={check.id}><span>{check.label}</span><span>{check.ok ? 'Passing' : 'Failing'}</span>{check.detail ? <span>{check.detail}</span> : null}</li>)}</ul> : null}
    {health && !health.healthy ? <Notice tone="warn" title="The local self-test did not pass." detail={health.error} /> : null}
    <p className="shaping-caption">A retained installation-log endpoint is not available in this gateway.</p>
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
      return <tr key={stage}><th>{name}<code>{stage}</code></th><td>{!evidence.measured ? <span className="unreported">{evidence.measuredRecords === 0 ? 'Not measured' : 'Not reported'}</span> : <SignedBytes value={evidence.delta} />}</td><td>{numeric(evidence.applied)}</td><td>{evidence.measuredRecords === null ? 'Unknown' : <><bdi dir="ltr">{numeric(evidence.measuredRecords)} / {numeric(evidence.records)}</bdi> records</>}</td></tr>;
    })}</tbody></table></div>
    <details className="shaping-technical"><summary>Separate units and reporting limits</summary><dl className="shaping-service-facts"><div><dt>Tool result characters removed</dt><dd>{numeric(window?.charsReduced)}</dd></div><div><dt>Headroom reported token reduction</dt><dd>{numeric(window?.proxyTokensSaved)}</dd></div><div><dt>PXPIPE estimated token reduction</dt><dd>{numeric(window?.estTokensSaved)}</dd></div><div><dt>Recorded transform duration, mean</dt><dd>{Number.isFinite(window?.avgMs) ? fmtUnit(window.avgMs, 'millisecond') : 'Not reported'}</dd></div><div><dt>Errors</dt><dd>Not reported</dd></div></dl><p>Errors can bypass the event sink, so zero errors would not establish successful execution. Character counts, reported tokens, token estimates and serialized bytes describe different quantities.</p></details>
    <details className="shaping-technical"><summary>Compression estimates by day</summary><p>PXPIPE only, from its retained daily records. Estimates do not establish billed token or cost reductions.</p>{timeline.length ? <div className="shaping-table-scroll"><table className="shaping-evidence-table"><thead><tr><th>UTC date</th><th>Estimated token reduction</th><th>Compressed / recorded</th></tr></thead><tbody>{timeline.map(day => <tr key={day.date}><th>{day.date}</th><td>{numeric(day.tokensSavedEst)}</td><td>{numeric(day.compressed)} / {numeric(day.requests)}</td></tr>)}</tbody></table></div> : <p>No compressed request is recorded in the returned daily history.</p>}</details>
    <details className="shaping-technical"><summary>Recent compression attempts</summary>{stats.data?.pxpipe?.recent?.length ? <ul className="shaping-observations">{stats.data.pxpipe.recent.slice(0, 20).map((row, index) => <li key={`${row.ts}-${index}`}><span>{fmtRelative(new Date(row.ts).toISOString())}</span><span>{row.applied ? 'Applied' : 'Bypassed'}{row.reason ? ` (${REASONS[row.reason] || row.reason})` : ''}</span><span>{numeric(row.tokensSavedEst)} estimated tokens</span><span>{numeric(row.durationMs)} ms</span><span>{numeric(row.imageCount)} images</span></li>)}</ul> : <p>No recent compression attempt is available in this sample.</p>}</details>
    <details className="shaping-technical"><summary>Tool disclosure records</summary>{disclosure.error ? <Notice {...refusal(disclosure.status, disclosure.error)} /> : null}{turns.length ? <div className="shaping-table-scroll"><table className="shaping-evidence-table"><thead><tr><th>Observed</th><th>Disclosed / original tools</th><th>Held back</th></tr></thead><tbody>{turns.slice(0, 20).map((turn, index) => <tr key={`${turn.ts}-${index}`}><th>{fmtRelative(new Date(turn.ts).toISOString())}</th><td>{numeric(turn.after)} / {numeric(turn.before)}</td><td>{numeric(turn.stripped)}</td></tr>)}</tbody></table></div> : <p>No disclosure record is available in this sample.</p>}</details>
  </section>;
}

export default function ShapingPage() {
  const settings = usePoll('/api/settings', 30000);
  const controls = usePoll('/api/admin/shaping', 30000);
  const [controlConsent, setControlConsent] = useState(false);
  const stats = usePoll('/api/token-saver/stats?timelineDays=30&recentLimit=100', 15000);
  const [view, setView] = useState('Everyday');
  const [opened, setOpened] = useState(['Everyday']);
  const [period, setPeriod] = useState('all');
  const [pending, setPendingState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState({});
  const [health, setHealth] = useState(null);
  const [serviceRevision, setServiceRevision] = useState(0);
  const s = controls.data?.settings ? { ...settings.data, ...controls.data.settings } : null;
  function setPending(action) {
    setControlConsent(false);
    setPendingState(action?.body ? { ...action, expectedCurrent: controls.data?.currentHash, before: controls.data?.settings } : action);
  }
  const chains = Object.entries(s?.comboStrategies || {}).filter(([, value]) => value && Object.hasOwn(value, 'tokenSaver')).map(([name, value]) => ({ name, value: value.tokenSaver }));
  const patch = configurationPatch(draft);
  function navigate(next) { setView(next); setOpened(previous => previous.includes(next) ? previous : [...previous, next]); }
  function close() { if (!busy) { setPending(null); setFailed(null); } }
  function toggle(control, on) {
    setFailed(null); setControlConsent(false);
    setPending({ title: `${on ? 'Turn on' : 'Turn off'} ${control.name.toLowerCase()}`, verb: on ? 'Turn on' : 'Turn off', layer: control.name, changes: `${controlScope(control)}. New requests take this setting; a request already in flight retains its settings. ${on ? control.effect : control.override ? 'This control is disabled globally; a supported routing-plan override may still enable it.' : 'New requests skip this globally disabled control.'}`, undo: 'Restore the previous setting here. Already removed request content cannot be recovered by changing this setting.', body: { [control.key]: on }, done: `${control.name} saved and verified after refresh.` });
  }
  async function run() {
    if (!pending || busy) return;
    const action = pending;
    if (action.body && (!action.expectedCurrent || !controlConsent)) { setFailed({ tone: 'warn', title: 'Review and consent to the enabled content-changing controls before saving.' }); return; }
    setBusy(true); setFailed(null); setNotice(null);
    if (action.url) setHealth(null);
    const after = action.body ? { ...action.before, ...action.body } : null;
    const response = await call(action.url || '/api/admin/shaping/controls', { method: 'POST', ...(action.body ? { body: { patch: action.body, expectedCurrent: action.expectedCurrent, consent: Object.keys(after).filter(key => after[key] === true) } } : {}) });
    const observedHealth = action.health ? response.body : response.body?.health;
    if (observedHealth && typeof observedHealth.healthy === 'boolean') { setHealth(observedHealth); setServiceRevision(value => value + 1); }
    if (!response.ok) { setFailed(response.body?.code === 'settings_conflict' ? { tone: 'warn', title: 'Settings changed after this view was read.', children: 'Refresh controls and review the change again. Your draft is retained.' } : refusal(response.status, response.body)); setBusy(false); return; }
    if (action.body) {
      const verification = await call('/api/admin/shaping');
      const verified = response.status !== 207 && verification.ok && verification.body?.currentHash === response.body?.afterHash && Object.entries(action.body).every(([key, value]) => JSON.stringify(verification.body?.settings?.[key]) === JSON.stringify(value));
      setNotice(verified ? { tone: 'ok', title: action.done } : { tone: 'warn', title: 'Save accepted; refreshed settings could not be confirmed.', children: 'Refresh the settings and inspect the control before making another change.' });
      settings.refresh(); controls.refresh(); setControlConsent(false);
      if (verified && action.configuration) setDraft({});
    } else { setNotice(observedHealth?.healthy === false ? { tone: 'warn', title: 'Operation finished, but the local self-test failed.', children: observedHealth.error } : { tone: 'ok', title: action.done }); setServiceRevision(value => value + 1); }
    setPending(null); setBusy(false);
  }
  function renderThresholds(stage) {
    const fields = THRESHOLDS.filter(field => field.stage === stage);
    return fields.length ? <div className="savings-thresholds" role="group" aria-label={`${CONTROLS.find(control => control.stage === stage)?.name} thresholds`}><div className="shaping-form">{fields.map(field => <label key={field.key} className="field"><span>{field.name}</span><div className="savings-threshold-input"><input className="input" name={field.key} type="number" inputMode="numeric" min={field.min} max={field.max} step="1" placeholder={field.nullable ? 'Default' : undefined} disabled={!s || busy || !!pending} value={draft[field.key] ?? s?.[field.key] ?? ''} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))} /><span className="shaping-caption">{field.unit}</span></div>{field.nullable ? <span className="shaping-caption">Blank inherits the runtime default.</span> : null}</label>)}</div></div> : null;
  }
  function renderConfiguration(control) {
    const fields = CONFIGURATION_FIELDS.filter(field => field.control === control.key);
    return fields.length ? <div className="savings-configuration">{fields.map(field => {
      const value = draft[field.key] ?? s?.[field.key];
      return <label key={field.key} className="field"><span>{field.name}</span>{field.list ? <><textarea className="input" name={field.key} rows={2} disabled={!s || busy || !!pending} value={Array.isArray(value) ? value.join('\n') : ''} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value === '' ? [] : event.target.value.split('\n') }))} /><span className="shaping-caption">One exact entry per line, up to 100 entries of 500 characters.</span></> : <select className="input" name={field.key} value={value ?? ''} disabled={!s || busy || !!pending} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))}>{value == null ? <option value="">Not reported</option> : null}{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select>}</label>;
    })}</div> : null;
  }
  return <div className="shaping-page">
    <header className="shaping-page-head"><div><h1>Token savings</h1><p>Keep requests focused. Review each change before it takes effect.</p></div><div className="shaping-header-observations"><span><span className="shaping-caption">Settings</span><Freshness status={pollFresh(controls)} lastDataAt={controls.goodAt} /></span><span><span className="shaping-caption">Measurements</span><Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} /></span></div></header>
    {settings.error ? <Notice {...refusal(settings.status, settings.error)} /> : null}
    {controls.error ? <Notice {...refusal(controls.status, controls.error)} /> : null}
    {stats.error ? <Notice {...refusal(stats.status, stats.error)} /> : null}
    {notice ? <div role="status"><Notice {...notice} /></div> : null}
    <Tabs value={view} onChange={navigate} keepMounted>
    <Tabs.List aria-label="Token savings views">{VIEWS.map(item => <Tabs.Tab key={item} value={item}>{item}</Tabs.Tab>)}</Tabs.List>
    <Tabs.Panel value="Everyday" pt="md">
      <TokenSavings settings={s} stageMap={{}} onToggle={toggle} onNavigate={navigate} loading={controls.loading} busy={busy || !!pending} onRefresh={() => { settings.refresh(); controls.refresh(); }} />
    </Tabs.Panel>
    <Tabs.Panel value="Advanced" pt="md">
      <TokenSavings mode="advanced" settings={s} stageMap={stats.data?.windows?.[period]?.stages || {}} recent={stats.data?.recent || []} period={period} onPeriod={setPeriod} onToggle={toggle} onNavigate={navigate} renderThresholds={renderThresholds} renderConfiguration={renderConfiguration} loading={controls.loading || stats.loading} unavailable={!!stats.error} busy={busy || !!pending} onRefresh={() => { settings.refresh(); controls.refresh(); stats.refresh(); }} />
      <details className="shaping-technical shaping-scope"><summary>Routing precedence and context-window policy</summary><p>Global settings are the baseline. The outermost routing-plan declaration wins; unspecified supported flags inherit global values. A plan can disable its 15 supported override flags; an explicit per-stage value wins over that plan gate. Privacy, disclosure, memory controls, content-change permissions and adaptive cache lifetime remain global.</p>{chains.length ? <ul className="shaping-observations">{chains.map(chain => <li key={chain.name}><code>{chain.name}</code><code>{JSON.stringify(chain.value)}</code></li>)}</ul> : <p>No routing-plan shaping override is configured.</p>}<p>Context-window overrides and cascade routing have separate settings and are outside shaping profiles.</p><div className="shaping-next"><Link href="/dashboard/models">Open model and plan settings</Link><Link href="/dashboard/model-context">Edit context-window overrides</Link></div></details>
    </Tabs.Panel>
    <Tabs.Panel value="Plan overrides" pt="md">{opened.includes('Plan overrides') ? <PlanOverrides globalSettings={controls.data?.settings} onSettingsChanged={() => { settings.refresh(); controls.refresh(); }} /> : null}</Tabs.Panel>
    <Tabs.Panel value="Profiles and comparison" pt="md">{opened.includes('Profiles and comparison') ? <ShapingWorkbench onSettingsChanged={() => { settings.refresh(); controls.refresh(); }} /> : null}</Tabs.Panel>
    <Tabs.Panel value="Services" pt="md">{opened.includes('Services') ? <><RuntimeSettings /><ServiceDetails key={serviceRevision} onAction={action => { setFailed(null); setPending(action); }} health={health} /></> : null}</Tabs.Panel>
    <Tabs.Panel value="Recorded evidence" pt="md">{opened.includes('Recorded evidence') ? <RecordedEvidence stats={stats} period={period} onPeriod={setPeriod} /> : null}</Tabs.Panel>
    </Tabs>
    {Object.keys(draft).length ? <div className="shaping-draft-bar"><span>{fmtNum(Object.keys(draft).length)} unsaved control settings</span>{!patch ? <span>Use valid levels, whole numbers within each field’s limits, and at most 100 list entries of 500 characters.</span> : null}<button type="button" className="button" disabled={!patch || busy || !!pending} onClick={() => { setFailed(null); setControlConsent(false); setPending({ title: 'Save control settings', verb: 'Save settings', changes: 'New requests use these global settings. In-flight requests retain their settings.', undo: 'Restore the previous values here.', body: patch, configuration: true, done: 'Control settings saved and verified after refresh.' }); }}>Review setting changes</button><button type="button" className="button quiet" disabled={busy || !!pending} onClick={() => setDraft({})}>Discard</button></div> : null}
    <Confirm open={!!pending} title={pending?.title} verb={pending?.verb} requires="A signed-in operator session on the gateway host." changes={pending?.changes} undo={pending?.undo} irreversible={pending?.irreversible} busy={busy} refusal={failed} onConfirm={run} onClose={close}>{pending?.body ? <Checkbox mt="md" mb="md" checked={controlConsent} onChange={event => setControlConsent(event.currentTarget.checked)} label="I have reviewed this change and consent to the enabled content-changing transformations. Existing saved controls remain in effect." /> : null}{pending?.layer ? <p>{pending.layer}</p> : null}{pending?.configuration ? <dl className="shaping-control-facts">{Object.entries(pending.body).map(([key, value]) => <div key={key}><dt>{controlLabel(key)}</dt><dd>{settingValue(pending.before?.[key])} → {settingValue(value)} {THRESHOLDS.find(field => field.key === key)?.unit}</dd></div>)}</dl> : null}</Confirm>
  </div>;
}
