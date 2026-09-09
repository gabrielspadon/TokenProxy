'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Badge, SegmentedControl, Table } from '@mantine/core';
import { ProviderMark } from '../ProviderMark';
import { CONTROLS, IDENTITY, IDENTITY_NOTE, STAGES, finite, orderedStages, quantity, signedBytes, utc } from './contextModel';
import styles from './context.module.css';
import { ContextStructureEvidence, ContextClientEvents, ContextCostEvidence, ContextAttemptComparison } from '@/shared/workspace/ContextEvidence';

import { ContextRoutingHistory } from './ContextRoutingHistory';

const STAGE_NAMES = Object.fromEntries(STAGES);
function Facts({ rows }) {
  return <dl className={styles.facts}>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? 'Unknown'}</dd></div>)}</dl>;
}
export function StageLedger({ stages = [], requestId }) {
  if (!stages.length) return <p className={styles.muted}>No stage boundaries were recorded for this attempt.</p>;
  const maximumChange = Math.max(0, ...stages.map(stage => finite(stage.deltaBytes) ? Math.abs(stage.deltaBytes) : 0));
  return <div className={styles.stageRegion} tabIndex={0} role="region" aria-label="Ordered stage measurements, scroll horizontally for all columns">
    <Table className={styles.stageTable} aria-label="Ordered shaping stages">
      <Table.Thead><Table.Tr><Table.Th># · Stage</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th><Table.Th>Change</Table.Th><Table.Th>Outcome / risk</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{orderedStages(stages).map((stage) => <Table.Tr key={`${stage.ordinal}-${stage.stage}`}>
        <Table.Td><span className={styles.ordinal}>{String(stage.ordinal + 1).padStart(2, '0')}</span>{STAGE_NAMES[stage.stage] || stage.stage}</Table.Td>
        <Table.Td>{quantity(stage.beforeBytes)} B</Table.Td><Table.Td>{quantity(stage.afterBytes)} B</Table.Td>
        <Table.Td className={styles.numeric} data-expansion={stage.deltaBytes > 0 || undefined}><span className={styles.stageChange}>{signedBytes(stage.deltaBytes)}<span className={styles.stageRail} aria-hidden="true">{finite(stage.deltaBytes) && <i data-expansion={stage.deltaBytes > 0 || undefined} style={{ width: `${maximumChange ? Math.abs(stage.deltaBytes) / maximumChange * 50 : 0}%` }} />}</span></span></Table.Td>
        <Table.Td><span className={styles.outcome} data-applied={stage.outcomeSource === 'execution' && stage.outcome === 'applied' || undefined}>{stage.outcomeSource === 'execution' ? stage.outcome || 'Unknown' : 'Historical byte measurement'}</span>{stage.outcomeSource === 'execution' && stage.errorCode && <small>{stage.errorCode.replaceAll('_',' ')}</small>}{stage.outcomeSource === 'execution' && stage.executionRequestId && <small>{requestId != null && String(stage.executionRequestId) !== String(requestId) ? 'Reused preparation from attempt ' : 'Prepared for attempt '}{stage.executionRequestId}</small>}<span className={styles.risk}>{stage.risk || 'Risk not recorded'}</span></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>
    <p className={styles.footnote}>Change = after − before. Bars share a signed byte scale centered at zero. Execution outcomes and failure codes appear only when explicitly recorded. Historical byte measurements do not establish execution, failure or cancellation. Negative values reduce the measured body. Missing stages are unobserved; this is not a complete pipeline total. Byte changes are not token, cost or semantic-equivalence measurements.</p>
  </div>;
}
function RecordedControls({ controls = {} }) {
  return <><div className={styles.controls}>{Object.entries(CONTROLS).map(([key, label]) => <div key={key}><span>{label}</span><Badge size="sm" variant="light" color={controls[key] === true ? key.endsWith('AllowLossy') ? 'orange' : 'teal' : 'gray'}>{controls[key] === true ? 'Enabled' : controls[key] === false ? 'Disabled' : 'Unknown'}</Badge></div>)}</div><p className={styles.footnote}>These settings were recorded with this request. Enabled does not mean a stage changed the body. <Link href="/dashboard/shaping">Open current shaping controls</Link></p></>;
}
export function HandoffEvidence({ rows, requestId, onInspect }) {
  if (!rows?.length) return null;
  return <section className={styles.measurementSection}><h3>Approved handoff evidence</h3>{rows.map(row => <div key={row.handoffId}>
    <Facts rows={[
      ['Packet', row.handoffId], ['Project', row.projectId], ['Content fingerprint', row.contentHash],
      ['Preparation origin', row.executionRequestId], ['Applied · UTC', utc(row.appliedAt)],
      ['Expiry · UTC', utc(row.expiresAt)], ['Revoked · UTC', row.revokedAt ? utc(row.revokedAt) : 'Not revoked'],
    ]} />
    <p className={styles.footnote}>{row.executionRequestId === requestId ? 'Prepared for this attempt.' : 'Reused preparation; this retry did not create another summary.'} This is an operator-approved addition, not a client-reported handoff event. Summary content is omitted.</p>
    {['source', 'target'].map(side => <p key={side}><button className="button quiet" disabled={!onInspect || !Number.isSafeInteger(row[`${side}SessionId`]) || row[`${side}SessionId`] < 1} onClick={() => onInspect({ kind: 'context-attempt', id: row[`${side}RequestId`], sessionId: row[`${side}SessionId`] })}>Inspect {side} request</button> <code>{row[`${side}RequestId`]}</code></p>)}
    <p className={styles.footnote}>Unavailable links have no retained Context session. Manage expiry or revocation in <Link href="/dashboard/shaping">Token savings → Profiles and comparison</Link>.</p>
  </div>)}</section>;
}

export function ContextInspector({ turn, detail, accounts = [], baseline, onBaseline, onClearBaseline, onSnapshot, onEconomics, onHandoff }) {
  const [view, setView] = useState('evidence');
  const accountName = (id) => accounts.find((account) => account.connectionId === id)?.displayName || id || 'Unknown account';
  const source = turn.usageSource === 'provider' ? 'Provider reported' : turn.usageSource === 'estimated' ? 'Estimated only' : 'Usage missing';
  return <div className={styles.inspector}>
    <SegmentedControl className={styles.evidenceTabs} aria-label="Request detail view" size="xs" value={view} onChange={setView} data={[{ value: 'evidence', label: 'Request & stages' }, { value: 'structure', label: 'Structure' }, { value: 'events', label: 'Client reports' }, { value: 'compare', label: 'Compare' }, { value: 'controls', label: 'Recorded controls' }, { value: 'routing', label: 'Session routing' }]} />
    {view === 'structure' ? <ContextStructureEvidence turn={turn} /> : view === 'events' ? <ContextClientEvents key={turn.id} turn={turn} sessionId={detail.session?.id} onSnapshot={onSnapshot} /> : view === 'compare' ? <ContextAttemptComparison turn={turn} baseline={baseline} onBaseline={onBaseline} onClear={onClearBaseline} /> : view === 'controls' ? <RecordedControls controls={turn.controls} /> : view === 'routing' ? <ContextRoutingHistory sessionId={detail.session.id} accountName={accountName} onSnapshot={onSnapshot} /> : <div className={styles.evidenceGrid}>
      <section className={styles.attemptOverview} aria-label="Selected attempt summary">
        <div className={styles.attemptRoute}><ProviderMark provider={turn.provider} size="small" /><div><strong>{turn.model || 'Unknown model'}</strong><span>{accountName(turn.connectionId)}</span></div><Badge variant="light" color={turn.status === 'success' || turn.status === 'ok' ? 'teal' : 'gray'}>{turn.status === 'pending' ? 'Incomplete' : turn.status || 'Unknown'}</Badge></div>
        <p className={styles.requestedModel}>Requested model <strong>{turn.requestedModel || 'Unknown'}</strong></p>
        <dl className={styles.attemptMeasures}>{[['Provider input', turn.providerInputTokens, 'tokens', 'input'], ['Cache read', turn.cacheReadTokens, 'tokens', 'cache'], ['Cache write', turn.cacheWriteTokens, 'tokens', 'write'], ['Output', turn.providerOutputTokens, 'tokens', 'output']].map(([label,value,unit,metric]) => <div key={label} data-metric={metric}><dt>{label}</dt><dd>{quantity(value,true)}<small>{unit}</small></dd></div>)}</dl>
        <div className={styles.attemptDelta}><span>Measured body change</span><strong data-expansion={turn.savedBytes < 0 || undefined}>{signedBytes(finite(turn.savedBytes) ? -turn.savedBytes : null)}</strong><span>{quantity(turn.latencyMs)} ms recorded latency</span></div>
        <p className={styles.footnote}>Input includes cache; these token quantities are not additive. Byte change measures the request body and does not establish monetary savings.</p>
      </section>
      <section className={styles.stageSection}><h3>Shaping sequence <span>{turn.stages?.length ?? 0} recorded boundaries</span></h3><StageLedger stages={turn.stages} requestId={turn.id} /></section>
      <HandoffEvidence rows={turn.handoffs} requestId={turn.id} onInspect={onHandoff} />
      <section className={styles.measurementSection}><h3>Request evidence <Badge variant="light" color={turn.usageSource === 'provider' ? 'teal' : 'gray'} size="sm">{source}</Badge></h3>
        <Facts rows={[
          ['Time · UTC', utc(turn.timestamp)], ['Recorded state', turn.status === 'pending' ? 'Pending / incomplete' : turn.status],
          ['Physical request', turn.id], ['Context session', turn.contextSessionId ?? detail.session?.id], ['Dispatch coverage', turn.dispatchCoverage], ['Logical request', turn.logicalRequestId], ['Upstream attempt', quantity(turn.attempt)],
          ['Selected provider / model', `${turn.provider || 'Unknown'} / ${turn.model || 'Unknown'}`],
          ['Served model', turn.status === 'success' || turn.status === 'ok' ? turn.model : 'Not confirmed'],
          ['Requested model', turn.requestedModel], ['Account', accountName(turn.connectionId)],
          ['Client', turn.clientTool], ['Route / formats', [turn.routeKind, turn.formatPair].filter(Boolean).join(' · ') || 'Unknown'],
          ['Selection reason', turn.selection], ['Context estimate', `${quantity(turn.contextEstimate)} tokens`],
          ['Provider input', `${quantity(turn.providerInputTokens)} tokens`],
          ['Cache read', `${quantity(turn.cacheReadTokens)} tokens`], ['Cache write', `${quantity(turn.cacheWriteTokens)} tokens`],
          ['Provider output', `${quantity(turn.providerOutputTokens)} tokens`],
          ['Estimated input / output', `${quantity(turn.estimatedInputTokens)} / ${quantity(turn.estimatedOutputTokens)} tokens`],
          ['Message / tool count', `${quantity(turn.messageCount)} / ${quantity(turn.toolCount)}`],
          ['Body before / after', `${quantity(turn.bodyBeforeBytes)} / ${quantity(turn.bodyAfterBytes)} B`],
          ['Net body change', signedBytes(finite(turn.savedBytes) ? -turn.savedBytes : null)],
          ['Recorded latency / first token', `${quantity(turn.latencyMs)} / ${quantity(turn.ttftMs)} ms`],
        ]} />
        <ContextCostEvidence records={turn.costRecords} onInspect={onEconomics} />
        {turn.compactHint && <p className={styles.caution}>A prefix discontinuity was observed. This is not proof of client compaction.</p>}
        <p className={styles.footnote}>{IDENTITY[detail.session?.identitySource] || 'Identity source unknown'}. {IDENTITY_NOTE[detail.session?.identitySource] || 'No distinct agent identity is asserted.'}</p>
      </section>
    </div>}
  </div>;
}
