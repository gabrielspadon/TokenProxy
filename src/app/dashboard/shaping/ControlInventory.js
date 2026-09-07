'use client';
import { useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { Group, Panel, Separator } from 'react-resizable-panels';
import Link from 'next/link';
import { fmtNum } from '@/shared/format';
import { CONTROLS, CONTROL_GROUPS, configuredState, controlFailure, controlScope, stageEvidence } from './controlCatalog';

export function SignedBytes({ value }) {
  return <bdi dir="ltr" className="shaping-number" data-growth={value > 0 || undefined} data-i18n-skip>{value > 0 ? '+' : ''}{fmtNum(value)} B</bdi>;
}

export function ControlInventory({ settings, stageMap, recent = [], onToggle, renderThresholds, onInvestigate }) {
  const [group, setGroup] = useState('All controls');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState('rtkEnabled');
  const narrow = useMediaQuery('(max-width: 760px)', false);
  const selected = CONTROLS.find(control => control.key === selection);
  const visible = CONTROLS.filter(control => (group === 'All controls' || group === control.group) && `${control.name} ${control.key} ${control.technical || ''}`.toLowerCase().includes(query.toLowerCase()));
  const evidence = stageEvidence(stageMap, selected.stage);
  const currentState = configuredState(settings, selected);
  const shared = CONTROLS.filter(control => control.stage && control.stage === selected.stage);
  const reasons = { epoch_boundary: 'Stable or unknown cache boundary', window_pressure: 'Below context-pressure threshold', no_backend: 'No compression sidecar configured', phantom: 'Reported reduction without corresponding body reduction' };
  const observations = recent.filter(record => record.saver === selected.stage).slice(0, 5);

  const inventoryPane = <div className="shaping-inventory">
      <div className="shaping-inventory-tools">
        <label className="shaping-search">Find a control<input className="input" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or setting" /></label>
        <label>Category<select className="input" value={group} onChange={event => setGroup(event.target.value)}>{['All controls', ...CONTROL_GROUPS].map(name => <option key={name}>{name}</option>)}</select></label>
      </div>
      <div className="shaping-inventory-heading"><h2>Control inventory</h2><span>{fmtNum(visible.length)} controls</span></div>
      <p className="shaping-caption">Select a control to inspect its gates and evidence.</p>
      <div className="shaping-control-list" aria-label="Shaping controls">
        {CONTROL_GROUPS.map(name => {
          const members = visible.filter(control => control.group === name);
          return members.length ? <div key={name} className="shaping-control-group"><h3>{name}</h3>{members.map(control => {
            const state = configuredState(settings, control);
            return <button key={control.key} type="button" className="shaping-control-row" aria-label={`Inspect ${control.name}`} aria-current={selection === control.key ? true : undefined} data-selected={selection === control.key || undefined} aria-controls="shaping-control-inspector" data-control={control.key} onClick={() => setSelection(control.key)}>
              <span className="shaping-control-name">{control.name}<span>{control.override ? 'Plan override supported' : 'Global only'}</span></span>
              <span className="shaping-state" data-state={state}>{state}</span>
              <span aria-hidden="true" className="shaping-selection-mark">›</span>
            </button>;
          })}</div> : null;
        })}
        {!visible.length ? <p className="shaping-empty">No control matches. Clear the search or choose another category.</p> : null}
      </div>
    </div>;
  const inspectorPane = <aside className="shaping-control-inspector" id="shaping-control-inspector" aria-labelledby="shaping-selected-name">
      <div className="shaping-inspector-head"><span>{selected.group}</span><span className="shaping-state" data-state={currentState}>{currentState}</span></div>
      <h2 id="shaping-selected-name">{selected.name}</h2>
      <p className="shaping-purpose">{selected.purpose}</p>
      <div className="shaping-inspector-action"><button className="button" type="button" disabled={currentState === 'Unknown'} onClick={() => onToggle(selected, currentState !== 'On')}>{currentState === 'On' ? 'Turn off' : 'Turn on'}</button><span>{selected.defaultOn ? 'On by default' : 'Off by default'}</span></div>
      <dl className="shaping-evidence-states">
        <div><dt>Configured</dt><dd>{currentState} globally</dd></div>
        <div><dt>Applicable</dt><dd>{currentState === 'Unknown' ? 'Settings unavailable' : selected.dependsOn && settings?.[selected.dependsOn] === false ? 'Parent control is off' : 'Depends on each request'}</dd></div>
        <div><dt>Executed</dt><dd>{evidence.applied === null ? 'No stage record' : `${fmtNum(evidence.applied)} applied stage records`}</dd></div>
        <div><dt>Measured</dt><dd>{evidence.measured ? <><SignedBytes value={evidence.delta} /><span><bdi dir="ltr" data-i18n-skip>{fmtNum(evidence.measuredRecords)} / {fmtNum(evidence.records)}</bdi> records measured</span></> : evidence.measuredRecords === 0 ? 'No recorded byte measurement' : 'Byte coverage unknown'}</dd></div>
      </dl>
      <p className="shaping-caption">Historical stage records do not establish this control’s effective setting or execution on a particular request.{shared.length > 1 ? ` ${shared.length} controls share this stage.` : ''}</p>
      <dl className="shaping-control-facts">
        <div><dt>Content effect</dt><dd>{selected.effect}</dd></div>
        <div><dt>Scope</dt><dd>{controlScope(selected)}. New requests take saved changes; in-flight requests retain their settings.</dd></div>
        <div><dt>Dependencies</dt><dd>{selected.dependency}</dd></div>
        <div><dt>Threshold</dt><dd>{selected.threshold}</dd></div>
        <div><dt>When it cannot apply</dt><dd>{controlFailure(selected)}</dd></div>
      </dl>
      {renderThresholds(selected.stage)}
      <details className="shaping-technical"><summary>Technical source and recorded outcomes</summary>
        <dl className="shaping-control-facts"><div><dt>Setting</dt><dd><code data-i18n-skip>{selected.key}</code></dd></div>{selected.technical ? <div><dt>Engine name</dt><dd data-i18n-skip>{selected.technical}</dd></div> : null}<div><dt>Source</dt><dd><code data-i18n-skip>{selected.source}</code></dd></div><div><dt>Stage</dt><dd>{selected.stage ? <code data-i18n-skip>{selected.stage}</code> : 'No dedicated byte-ledger stage'}</dd></div></dl>
        {observations.length ? <ul className="shaping-observations">{observations.map((row, index) => <li key={`${row.ts}-${index}`}><span>{row.applied ? 'Applied record' : 'Bypassed record'}</span><span>{reasons[row.reason] || 'Specific reason not retained'}</span>{Number.isFinite(row.bytesSaved) ? <SignedBytes value={row.bytesSaved} /> : <span>Bytes not recorded</span>}</li>)}</ul> : <p>No recent stage outcome is available in this bounded sample. Absence is not proof the stage never ran.</p>}
      </details>
      <div className="shaping-next"><Link href="/dashboard/context">Inspect request evidence</Link><button type="button" className="link-button" onClick={onInvestigate}>Compare saved profiles</button></div>
    </aside>;
  return narrow ? <div className="shaping-control-workspace">{inventoryPane}{inspectorPane}</div> : <Group className="shaping-control-workspace shaping-resizable" style={{ height: 'min(760px, 76dvh)', alignItems: 'stretch' }} orientation="horizontal" id="shaping-inspection-layout">
    <Panel id="shaping-inventory-pane" defaultSize="45%" minSize="30%">{inventoryPane}</Panel>
    <Separator className="shaping-resize-handle" aria-label="Resize control inspector" />
    <Panel id="shaping-inspector-pane" defaultSize="55%" minSize="35%">{inspectorPane}</Panel>
  </Group>;
}
