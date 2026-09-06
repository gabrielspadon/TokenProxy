'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Badge, SegmentedControl, Table } from '@mantine/core';
import { CONTROLS, IDENTITY, IDENTITY_NOTE, STAGES, finite, orderedStages, quantity, signedBytes, utc } from './contextModel';
import styles from './context.module.css';
import { ContextStructureEvidence, ContextClientEvents, ContextCostEvidence, ContextAttemptComparison } from '@/shared/workspace/ContextEvidence';

const STAGE_NAMES = Object.fromEntries(STAGES);
function Facts({ rows }) {
  return <dl className={styles.facts}>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? 'Unknown'}</dd></div>)}</dl>;
}
export function StageLedger({ stages = [] }) {
  if (!stages.length) return <p className={styles.muted}>No stage boundaries were recorded for this attempt.</p>;
  return <div className={styles.stageRegion}>
    <Table className={styles.stageTable} aria-label="Ordered shaping stages">
      <Table.Thead><Table.Tr><Table.Th># · Stage</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th><Table.Th>Change</Table.Th><Table.Th>Outcome / risk</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{orderedStages(stages).map((stage) => <Table.Tr key={`${stage.ordinal}-${stage.stage}`}>
        <Table.Td><span className={styles.ordinal}>{String(stage.ordinal + 1).padStart(2, '0')}</span>{STAGE_NAMES[stage.stage] || stage.stage}</Table.Td>
        <Table.Td>{quantity(stage.beforeBytes)} B</Table.Td><Table.Td>{quantity(stage.afterBytes)} B</Table.Td>
        <Table.Td className={styles.numeric} data-expansion={stage.deltaBytes > 0 || undefined}>{signedBytes(stage.deltaBytes)}</Table.Td>
        <Table.Td><span className={styles.outcome} data-applied={stage.outcome === 'applied' || undefined}>{stage.outcome || 'Unknown'}</span><span className={styles.risk}>{stage.risk || 'Risk not recorded'}</span></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>
    <p className={styles.footnote}>Change = after − before. Negative values reduce the measured body. Byte changes are not token, cost or semantic-equivalence measurements.</p>
  </div>;
}
function RecordedControls({ controls = {} }) {
  return <><div className={styles.controls}>{Object.entries(CONTROLS).map(([key, label]) => <div key={key}><span>{label}</span><Badge size="sm" variant="light" color={controls[key] === true ? key.endsWith('AllowLossy') ? 'orange' : 'indigo' : 'gray'}>{controls[key] === true ? 'Enabled' : controls[key] === false ? 'Disabled' : 'Unknown'}</Badge></div>)}</div><p className={styles.footnote}>These settings were recorded with this request. Enabled does not mean a stage changed the body. <Link href="/dashboard/shaping">Open current shaping controls</Link></p></>;
}
function RoutingReceipts({ detail, accountName }) {
  return <div className={styles.routing}>
    <p className={styles.footnote}>{detail.routingScope || 'Latest retained routing receipts are independent of the selected request interval.'}</p>
    <div className={styles.routingColumns}>
      <section><h3>Stored account pins</h3>{detail.pins?.length ? <Table className={styles.table} aria-label="Stored account pins"><Table.Thead><Table.Tr><Table.Th>Model / account</Table.Th><Table.Th>Pinned · UTC</Table.Th><Table.Th>Expiry · UTC</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{detail.pins.map((pin, index) => <Table.Tr key={`${pin.model}-${index}`}><Table.Td>{pin.model}<small>{accountName(pin.connectionId)}</small></Table.Td><Table.Td>{utc(pin.pinnedAt)}</Table.Td><Table.Td>{utc(pin.expiresAt)}</Table.Td></Table.Tr>)}</Table.Tbody></Table> : <p className={styles.muted}>No retained pins for this identity.</p>}</section>
      <section><h3>Account switch receipts</h3>{detail.switches?.length ? <Table className={styles.table} aria-label="Account switch receipts"><Table.Thead><Table.Tr><Table.Th>When · UTC</Table.Th><Table.Th>Transition</Table.Th><Table.Th>Recorded reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{detail.switches.map((item) => <Table.Tr key={item.id}><Table.Td>{utc(item.switchedAt)}</Table.Td><Table.Td>{accountName(item.fromConnectionId)} → {accountName(item.toConnectionId)}<small>{item.model}</small></Table.Td><Table.Td>{item.trigger || 'Unknown'}<small>{item.reason}</small></Table.Td></Table.Tr>)}</Table.Tbody></Table> : <p className={styles.muted}>No retained switch receipts for this identity.</p>}</section>
    </div>
  </div>;
}
export function ContextInspector({ turn, detail, accounts = [], baseline, onBaseline, onClearBaseline, onSnapshot }) {
  const [view, setView] = useState('evidence');
  const accountName = (id) => accounts.find((account) => account.connectionId === id)?.displayName || id || 'Unknown account';
  const source = turn.usageSource === 'provider' ? 'Provider reported' : turn.usageSource === 'estimated' ? 'Estimated only' : 'Usage missing';
  return <div className={styles.inspector}>
    <SegmentedControl className={styles.evidenceTabs} aria-label="Request detail view" size="xs" value={view} onChange={setView} data={[{ value: 'evidence', label: 'Request & stages' }, { value: 'structure', label: 'Structure' }, { value: 'events', label: 'Client reports' }, { value: 'compare', label: 'Compare' }, { value: 'controls', label: 'Recorded controls' }, { value: 'routing', label: 'Session routing' }]} />
    {view === 'structure' ? <ContextStructureEvidence turn={turn} /> : view === 'events' ? <ContextClientEvents key={turn.id} turn={turn} sessionId={detail.session?.id} onSnapshot={onSnapshot} /> : view === 'compare' ? <ContextAttemptComparison turn={turn} baseline={baseline} onBaseline={onBaseline} onClear={onClearBaseline} /> : view === 'controls' ? <RecordedControls controls={turn.controls} /> : view === 'routing' ? <RoutingReceipts detail={detail} accountName={accountName} /> : <div className={styles.evidenceGrid}>
      <section className={styles.measurementSection}><h3>Request evidence <Badge variant="light" color={turn.usageSource === 'provider' ? 'teal' : 'gray'} size="sm">{source}</Badge></h3>
        <Facts rows={[
          ['Time · UTC', utc(turn.timestamp)], ['Recorded state', turn.status === 'pending' ? 'Pending / incomplete' : turn.status],
          ['Physical request', turn.id], ['Context session', turn.contextSessionId ?? detail.session?.id], ['Dispatch coverage', turn.dispatchCoverage], ['Logical request', turn.logicalRequestId], ['Upstream attempt', quantity(turn.attempt)],
          ['Served provider / model', `${turn.provider || 'Unknown'} / ${turn.model || 'Unknown'}`],
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
        <ContextCostEvidence records={turn.costRecords} />
        {turn.compactHint && <p className={styles.caution}>A prefix discontinuity was observed. This is not proof of client compaction.</p>}
        <p className={styles.footnote}>{IDENTITY[detail.session?.identitySource] || 'Identity source unknown'}. {IDENTITY_NOTE[detail.session?.identitySource] || 'No distinct agent identity is asserted.'}</p>
      </section>
      <section className={styles.stageSection}><h3>Shaping sequence <span>{turn.stages?.length ?? 0} recorded boundaries</span></h3><StageLedger stages={turn.stages} /></section>
    </div>}
  </div>;
}
