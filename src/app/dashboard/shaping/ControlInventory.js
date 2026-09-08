'use client';
import { UNAVAILABLE_CONTROLS } from '@/lib/shaping/runtimeSupport';
import Link from 'next/link';
import { fmtNum } from '@/shared/format';
import { CONTROLS, configuredState, controlFailure, controlScope, stageEvidence } from './controlCatalog';

export function SignedBytes({ value }) {
  return <bdi dir="ltr" className="shaping-number" data-growth={value > 0 || undefined}>{value > 0 ? '+' : ''}{fmtNum(value)} B</bdi>;
}

export function ControlEvidence({ control, settings, stageMap, recent = [], onInvestigate }) {
  const evidence = stageEvidence(stageMap, control.stage);
  const currentState = configuredState(settings, control);
  const unavailable = UNAVAILABLE_CONTROLS[control.key];
  const shared = CONTROLS.filter(item => item.stage && item.stage === control.stage);
  const reasons = { epoch_boundary: 'Stable or unknown cache boundary', window_pressure: 'Below context-pressure threshold', no_backend: 'No compression sidecar configured', phantom: 'Reported reduction without corresponding body reduction' };
  const observations = recent.filter(record => record.saver === control.stage).slice(0, 5);

  return <details className="savings-control-details">
      <summary aria-label={`Evidence and requirements for ${control.name}`}>Evidence and requirements</summary>
      {unavailable ? <p role="status">Runtime unavailable. {unavailable} Saved value {currentState.toLowerCase()} is preserved for compatibility.</p> : null}
      <dl className="shaping-evidence-states">
        <div><dt>Configured</dt><dd>{currentState} globally</dd></div>
        <div><dt>Applicable</dt><dd>{unavailable ? 'Runtime unavailable' : currentState === 'Unknown' ? 'Settings unavailable' : control.dependsOn && settings?.[control.dependsOn] === false ? 'Parent control is off globally; plan overrides may differ' : 'Depends on each request'}</dd></div>
        <div><dt>Executed</dt><dd>{evidence.applied === null ? 'No stage record' : `${fmtNum(evidence.applied)} applied stage records`}</dd></div>
        <div><dt>Measured</dt><dd>{evidence.measured ? <><SignedBytes value={evidence.delta} /><span><bdi dir="ltr">{fmtNum(evidence.measuredRecords)} / {fmtNum(evidence.records)}</bdi> records measured</span></> : evidence.measuredRecords === 0 ? 'No recorded byte measurement' : 'Byte coverage unknown'}</dd></div>
      </dl>
      <p className="shaping-caption">Historical stage records do not establish this control’s effective setting or execution on a particular request.{shared.length > 1 ? ` ${shared.length} controls share this stage.` : ''}</p>
      <dl className="shaping-control-facts">
        <div><dt>Content effect</dt><dd>{control.effect}</dd></div>
        <div><dt>Scope</dt><dd>{controlScope(control)}. New requests take saved changes; in-flight requests retain their settings.</dd></div>
        <div><dt>Dependencies</dt><dd>{control.dependency}</dd></div>
        <div><dt>Threshold</dt><dd>{control.threshold}</dd></div>
        <div><dt>When it cannot apply</dt><dd>{controlFailure(control)}</dd></div>
      </dl>
        <dl className="shaping-control-facts"><div><dt>Setting</dt><dd><code>{control.key}</code></dd></div>{control.technical ? <div><dt>Engine name</dt><dd>{control.technical}</dd></div> : null}<div><dt>Source</dt><dd><code>{control.source}</code></dd></div><div><dt>Stage</dt><dd>{control.stage ? <code>{control.stage}</code> : 'No dedicated byte-ledger stage'}</dd></div></dl>
        {observations.length ? <ul className="shaping-observations">{observations.map((row, index) => <li key={`${row.ts}-${index}`}><span>{row.applied ? 'Applied record' : 'Bypassed record'}</span><span>{reasons[row.reason] || 'Specific reason not retained'}</span>{Number.isFinite(row.bytesSaved) ? <SignedBytes value={row.bytesSaved} /> : <span>Bytes not recorded</span>}</li>)}</ul> : <p>No recent stage outcome is available in this bounded sample. Absence is not proof the stage never ran.</p>}
      <div className="shaping-next"><Link href="/dashboard/context">Inspect request evidence</Link><button type="button" className="link-button" onClick={onInvestigate}>Compare saved profiles</button></div>
    </details>;
}
