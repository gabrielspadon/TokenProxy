'use client';
import { useState } from 'react';
import { Button, NativeSelect, Switch, TextInput } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { UNAVAILABLE_CONTROLS } from '@/lib/shaping/runtimeSupport';
import { fmtNum } from '@/shared/format';
import { CONTROLS, CONTROL_GROUPS, configuredState, stageEvidence } from './controlCatalog';
import { SignedBytes } from './ControlInventory';

const DESCRIPTIONS = {
  'Tool traffic': 'Reduce repeated output and choose which tools reach the model.',
  History: 'Keep recent work intact while reducing older context.',
  Compression: 'Control local compression and its content-change permissions.',
  Instructions: 'Choose response style and treatment of historical reasoning.',
  'Privacy and cache': 'Manage private terms and cache lifetime.',
};

export function TokenSavings({ settings, stageMap, period, onPeriod, onToggle, onAdvanced, loading, unavailable, onRefresh, busy }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [showEvidence, setShowEvidence] = useLocalStorage({ key: 'tokenproxy.savings.measurements', defaultValue: true });
  const [expanded, setExpanded] = useLocalStorage({ key: 'tokenproxy.savings.categories', defaultValue: ['Tool traffic'] });
  const on = settings ? CONTROLS.filter(control => configuredState(settings, control) === 'On') : [];
  const unavailableOn = on.filter(control => UNAVAILABLE_CONTROLS[control.key]);
  const visible = CONTROLS.filter(control => {
    const state = configuredState(settings, control);
    return (category === 'all' || category === control.group)
      && (filter === 'all' || filter === 'on' && state === 'On' || filter === 'off' && state === 'Off')
      && `${control.name} ${control.purpose} ${control.technical || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const stages = [...new Set(CONTROLS.map(control => control.stage).filter(Boolean))]
    .map(stage => ({ stage, name: CONTROLS.find(control => control.stage === stage).name, shared: CONTROLS.filter(control => control.stage === stage).length, ...stageEvidence(stageMap, stage) }))
    .filter(stage => stage.records !== null);
  const largest = Math.max(1, ...stages.filter(stage => stage.measured).map(stage => Math.abs(stage.delta)));
  function resetFilters() { setQuery(''); setCategory('all'); setFilter('all'); }

  return <section className="savings-overview" aria-label="Token savings control panel">
    <div className="savings-status-strip">
      <div><span>Configured on</span><strong>{settings ? fmtNum(on.length) : 'Unknown'}</strong><span>of {CONTROLS.length} global controls</span></div>
      <div><span>Plan overrides</span><strong>{settings ? fmtNum(Object.values(settings.comboStrategies || {}).filter(value => value && Object.hasOwn(value, 'tokenSaver')).length) : 'Unknown'}</strong><button type="button" className="link-button" onClick={() => onAdvanced('Plan overrides')}>Review exceptions</button></div>
      <div className="savings-status-context"><span>Changes apply to new requests. On means saved globally; request conditions and plan overrides determine what runs.</span>{unavailableOn.length ? <span>{unavailableOn.length} enabled control has no connected runtime.</span> : null}</div>
    </div>
    <div className="savings-toolbar">
      <TextInput type="search" label="Find savings controls" placeholder="Search controls" value={query} onChange={event => setQuery(event.currentTarget.value)} />
      <NativeSelect label="Show controls" value={filter} onChange={event => setFilter(event.currentTarget.value)} data={[{ value: 'all', label: 'All states' }, { value: 'on', label: 'Configured on' }, { value: 'off', label: 'Configured off' }]} />
      <NativeSelect label="Category" value={category} onChange={event => setCategory(event.currentTarget.value)} data={[{ value: 'all', label: 'All categories' }, ...CONTROL_GROUPS.map(group => ({ value: group, label: group }))]} />
      <Button variant="default" onClick={onRefresh}>Refresh controls</Button>
    </div>
    {!settings ? <p className="shaping-empty" role="status">{loading ? 'Reading saved savings controls…' : 'Savings controls could not be read. Refresh controls to try again.'}</p> : null}
    <div className="savings-categories">{CONTROL_GROUPS.map(group => {
      const members = visible.filter(control => control.group === group);
      if (!members.length) return null;
      const allMembers = CONTROLS.filter(control => control.group === group);
      const enabled = allMembers.filter(control => configuredState(settings, control) === 'On').length;
      const open = query.trim() !== '' || filter !== 'all' || category !== 'all' || (Array.isArray(expanded) && expanded.includes(group));
      const sectionId = `savings-category-${CONTROL_GROUPS.indexOf(group)}`;
      return <section key={group} className="savings-category" aria-label={`${group} controls`}>
        <header><div><h2>{group}</h2><p>{DESCRIPTIONS[group]}</p></div><div className="savings-category-actions"><span className="savings-category-count">{settings ? `${enabled} / ${allMembers.length} on` : 'Unknown'}</span><Button variant="subtle" size="compact-sm" aria-label={`${open ? 'Hide' : 'Show'} ${group} controls`} aria-expanded={open} aria-controls={sectionId} disabled={query.trim() !== '' || filter !== 'all' || category !== 'all'} onClick={() => setExpanded(previous => { const current = Array.isArray(previous) ? previous : []; return current.includes(group) ? current.filter(value => value !== group) : [...current, group]; })}>{open ? 'Hide controls' : 'Show controls'}</Button></div></header>
        <div id={sectionId} hidden={!open} className="savings-control-cards">{members.map(control => {
          const state = configuredState(settings, control);
          const unsupported = UNAVAILABLE_CONTROLS[control.key];
          return <article key={control.key} className="savings-control-card" data-state={state} data-savings-control={control.key}>
            <div className="savings-control-title"><h3>{control.name}</h3><span className="shaping-state" data-state={state}>{state}</span></div>
            <p>{control.purpose}</p>
            <div className="savings-control-footer"><span>{unsupported ? 'Runtime unavailable' : control.dependsOn && settings?.[control.dependsOn] !== true ? 'Parent control is not on globally' : control.override ? 'Plans can override' : 'Global setting'}</span><Switch label={`Enable ${control.name}`} aria-label={`Enable ${control.name}`} styles={{ label: { display: 'none' } }} checked={state === 'On'} disabled={state === 'Unknown' || !!unsupported || busy} onChange={event => onToggle(control, event.currentTarget.checked)} /></div>
            <details className="savings-control-details"><summary>Effect and requirements</summary><p>{control.effect}</p><p>{unsupported || control.dependency}</p><Button variant="subtle" size="compact-sm" onClick={() => onAdvanced('Controls', control.key)}>Edit thresholds and inspect evidence</Button></details>
          </article>;
        })}</div>
      </section>;
    })}</div>
    {!visible.length ? <div className="shaping-empty"><p>No savings control matches these filters.</p><Button variant="default" onClick={resetFilters}>Reset filters</Button></div> : null}
    <div className="savings-evidence-head"><h2>Measured request changes</h2><Button variant="subtle" onClick={() => setShowEvidence(value => !value)} aria-expanded={showEvidence} aria-controls="savings-byte-evidence">{showEvidence ? 'Hide measurements' : 'Show measurements'}</Button></div>
    <section id="savings-byte-evidence" className="savings-byte-evidence" hidden={!showEvidence} aria-label="Measured request bytes by stage">
      <div className="savings-evidence-tools"><p>Serialized request bytes, by stage. These are not billed token or cost savings. Stages overlap and are not added together.</p><NativeSelect label="Measurement period" value={period} onChange={event => onPeriod(event.currentTarget.value)} data={[{ value: 'all', label: 'Retained history' }, { value: 'today', label: 'Today' }, { value: 'last7d', label: 'Last 7 days' }, { value: 'last30d', label: 'Last 30 days' }]} /></div>
      {unavailable ? <p role="status">Measurements could not be refreshed. Any retained measurements below may be stale.</p> : null}
      <div className="savings-byte-legend"><span>← Request reduction</span><span>Request growth →</span></div>
      {stages.length ? <div className="savings-byte-rows">{stages.map(stage => <div className="savings-byte-row" key={stage.stage}>
        <span>{stage.name}<small>{stage.measuredRecords === null ? 'Coverage unknown' : `${fmtNum(stage.measuredRecords)} / ${fmtNum(stage.records)} records measured`}{stage.shared > 1 ? `; ${stage.shared} controls share this stage` : ''}</small></span>
        <div className="savings-byte-track" aria-hidden="true">{stage.measured && stage.delta !== 0 ? <span data-growth={stage.delta > 0 || undefined} style={{ width: `${Math.abs(stage.delta) / largest * 50}%` }} /> : null}</div>
        <span>{stage.measured ? <SignedBytes value={stage.delta} /> : 'Not measured'}</span>
      </div>)}</div> : <p className="shaping-empty">{loading ? 'Reading measurements…' : unavailable ? 'No measurements are available.' : 'No recorded stage changes in this period. Measurements appear after eligible requests run.'}</p>}
      <Button variant="subtle" onClick={() => onAdvanced('Recorded evidence')}>Open detailed evidence</Button>
    </section>
  </section>;
}
