'use client';
import { useState } from 'react';
import { Button, NativeSelect, TextInput } from '@mantine/core';
import { UNAVAILABLE_CONTROLS } from '@/lib/shaping/runtimeSupport';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import Link from 'next/link';
import { fmtNum } from '@/shared/format';
import { CONTROLS, CONTROL_GROUPS, configuredState, controlFailure, controlScope, stageEvidence } from './controlCatalog';

export function SignedBytes({ value }) {
  return <bdi dir="ltr" className="shaping-number" data-growth={value > 0 || undefined}>{value > 0 ? '+' : ''}{fmtNum(value)} B</bdi>;
}

export function ControlInventory({ settings, stageMap, recent = [], onToggle, renderThresholds, onInvestigate, initialSelection = null }) {
  const [group, setGroup] = useState('All controls');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(initialSelection);
  const selected = CONTROLS.find(control => control.key === selection) || CONTROLS[0];
  const visible = CONTROLS.filter(control => (group === 'All controls' || group === control.group) && `${control.name} ${control.key} ${control.technical || ''}`.toLowerCase().includes(query.toLowerCase()));
  const evidence = stageEvidence(stageMap, selected.stage);
  const currentState = configuredState(settings, selected);
  const unavailable = UNAVAILABLE_CONTROLS[selected.key];
  const shared = CONTROLS.filter(control => control.stage && control.stage === selected.stage);
  const reasons = { epoch_boundary: 'Stable or unknown cache boundary', window_pressure: 'Below context-pressure threshold', no_backend: 'No compression sidecar configured', phantom: 'Reported reduction without corresponding body reduction' };
  const observations = recent.filter(record => record.saver === selected.stage).slice(0, 5);

  const inventoryPane = <div className="shaping-inventory">
      <div className="shaping-inventory-tools">
        <TextInput label="Find a control" type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="Name or setting" />
        <NativeSelect label="Category" value={group} onChange={event => setGroup(event.currentTarget.value)} data={['All controls', ...CONTROL_GROUPS]} />
      </div>
      <div className="shaping-inventory-heading"><h2>Control inventory</h2><span>{fmtNum(visible.length)} controls</span></div>
      <p className="shaping-caption">Select a control to inspect its gates and evidence.</p>
      <div className="shaping-control-list" role="region" tabIndex={0} aria-label="Shaping controls">
        {CONTROL_GROUPS.map(name => {
          const members = visible.filter(control => control.group === name);
          return members.length ? <div key={name} className="shaping-control-group"><h3>{name}</h3>{members.map(control => {
            const state = configuredState(settings, control);
            return <button key={control.key} type="button" className="shaping-control-row" aria-label={`Inspect ${control.name}`} aria-current={selection === control.key ? true : undefined} data-selected={selection === control.key || undefined} aria-controls={selection ? 'shaping-control-inspector' : undefined} data-control={control.key} onClick={() => setSelection(control.key)}>
              <span className="shaping-control-name">{control.name}<span>{UNAVAILABLE_CONTROLS[control.key] ? 'Runtime unavailable' : control.override ? 'Plan override supported' : 'Global only'}</span></span>
              <span className="shaping-state" data-state={state}>{state}</span>
              <span aria-hidden="true" className="shaping-selection-mark">›</span>
            </button>;
          })}</div> : null;
        })}
        {!visible.length ? <p className="shaping-empty">No control matches. Clear the search or choose another category.</p> : null}
      </div>
    </div>;
  const inspectorPane = <section className="shaping-control-inspector" id="shaping-control-inspector" aria-label={`${selected.name} settings and measurements`} tabIndex={0}>
      <div className="shaping-inspector-head"><span>{selected.group}</span><span className="shaping-state" data-state={currentState}>{currentState}</span></div>
      <p className="shaping-purpose">{selected.purpose}</p>
      <div className="shaping-inspector-action">{unavailable ? <p role="status"><strong>Runtime unavailable.</strong> {unavailable} Saved value {currentState.toLowerCase()} is preserved for compatibility.</p> : <><Button disabled={currentState === 'Unknown'} onClick={() => onToggle(selected, currentState !== 'On')}>{currentState === 'On' ? 'Turn off' : 'Turn on'}</Button><span>{selected.defaultOn ? 'On by default' : 'Off by default'}</span></>}</div>
      <dl className="shaping-evidence-states">
        <div><dt>Configured</dt><dd>{currentState} globally</dd></div>
        <div><dt>Applicable</dt><dd>{unavailable ? 'Runtime unavailable' : currentState === 'Unknown' ? 'Settings unavailable' : selected.dependsOn && settings?.[selected.dependsOn] === false ? 'Parent control is off globally; plan overrides may differ' : 'Depends on each request'}</dd></div>
        <div><dt>Executed</dt><dd>{evidence.applied === null ? 'No stage record' : `${fmtNum(evidence.applied)} applied stage records`}</dd></div>
        <div><dt>Measured</dt><dd>{evidence.measured ? <><SignedBytes value={evidence.delta} /><span><bdi dir="ltr">{fmtNum(evidence.measuredRecords)} / {fmtNum(evidence.records)}</bdi> records measured</span></> : evidence.measuredRecords === 0 ? 'No recorded byte measurement' : 'Byte coverage unknown'}</dd></div>
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
        <dl className="shaping-control-facts"><div><dt>Setting</dt><dd><code>{selected.key}</code></dd></div>{selected.technical ? <div><dt>Engine name</dt><dd>{selected.technical}</dd></div> : null}<div><dt>Source</dt><dd><code>{selected.source}</code></dd></div><div><dt>Stage</dt><dd>{selected.stage ? <code>{selected.stage}</code> : 'No dedicated byte-ledger stage'}</dd></div></dl>
        {observations.length ? <ul className="shaping-observations">{observations.map((row, index) => <li key={`${row.ts}-${index}`}><span>{row.applied ? 'Applied record' : 'Bypassed record'}</span><span>{reasons[row.reason] || 'Specific reason not retained'}</span>{Number.isFinite(row.bytesSaved) ? <SignedBytes value={row.bytesSaved} /> : <span>Bytes not recorded</span>}</li>)}</ul> : <p>No recent stage outcome is available in this bounded sample. Absence is not proof the stage never ran.</p>}
      </details>
      <div className="shaping-next"><Link href="/dashboard/context">Inspect request evidence</Link><button type="button" className="link-button" onClick={onInvestigate}>Compare saved profiles</button></div>
    </section>;
  return <div className="shaping-control-layout"><SelectionDock height="var(--shaping-control-height)" closedMaxHeight="var(--shaping-control-height)" open={Boolean(selection)} title={selected.name} subtitle={selected.group} onClose={() => setSelection(null)} detail={inspectorPane}>{inventoryPane}</SelectionDock></div>;
}
