'use client';
import { useState } from 'react';
import { Alert, Button, Group, Modal, Table, Text } from '@mantine/core';
import { applyDrainChanges } from './capacityControlsModel';
import styles from './capacity.module.css';

export function CapacityControls({ accounts, drains, onChanged }) {
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState([]);
  const ready = accounts.length > 0 && !drains.error && !drains.loading && accounts.every(account => drains.data?.connections?.some(item => item.connectionId === account.connectionId && item.version));
  const propose = isDraining => {
    setOutcomes([]);
    setProposal({ isDraining, targets: accounts.map(account => ({ ...drains.data.connections.find(item => item.connectionId === account.connectionId), name: account.displayName || account.connectionId })) });
  };
  return <section className={styles.controls} aria-label="Account drain controls">
    <h3>New account selections</h3>
    <Text size="sm">Draining blocks new selections and lets active streams finish. Existing pins stay recorded; routing can move a later request away from a draining account. Stopping the drain restores eligibility for new selections subject to all other gates.</Text>
    <Group mt="sm"><Button variant="light" disabled={!ready || busy} onClick={() => propose(true)}>Review drain{accounts.length > 1 ? ` for ${accounts.length} accounts` : ''}</Button><Button variant="default" disabled={!ready || busy} onClick={() => propose(false)}>Review stop drain</Button></Group>
    {!ready && <Text size="sm" c="dimmed">Current drain versions are unavailable. Refresh account state before changing it.</Text>}
    <Modal opened={Boolean(proposal)} onClose={() => { if (!busy) setProposal(null); }} title={proposal?.isDraining ? 'Review account drain' : 'Review stopping the drain'} centered closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy} size="lg">
      <Text size="sm">This changes only the listed accounts when each save succeeds. The enabled setting is independent and active streams are not cancelled. Each account is saved separately and earlier changes are retained if another fails. Reverse this with {proposal?.isDraining ? 'Stop drain' : 'Drain'}.</Text>
      <Table mt="md" aria-label="Drain proposal accounts"><Table.Thead><Table.Tr><Table.Th>Account</Table.Th><Table.Th>Current drain</Table.Th><Table.Th>Observed pending</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{proposal?.targets.map(target => <Table.Tr key={target.connectionId}><Table.Td>{target.name}<br/><bdi className={styles.measured}>{target.connectionId}</bdi></Table.Td><Table.Td>{target.isDraining ? 'Draining' : 'Not draining'}</Table.Td><Table.Td>{target.activeStreams ?? 'Unknown'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Text size="sm" c="dimmed" mt="xs">Process counters can expire or lag. They do not establish whether a response is still streaming.</Text>
      <Group mt="md" justify="end"><Button variant="default" disabled={busy} onClick={() => setProposal(null)}>Close</Button><Button loading={busy} disabled={busy || outcomes.length > 0} onClick={async () => {
        setBusy(true);
        try { await applyDrainChanges(proposal.targets, proposal.isDraining, fetch, setOutcomes); }
        finally { setBusy(false); onChanged?.(); }
      }}>{proposal?.isDraining ? 'Apply drain' : 'Stop drain'}</Button></Group>
      {outcomes.length > 0 && <div aria-live="polite" aria-label="Per-account drain outcomes">{outcomes.map(outcome => <Alert mt="sm" key={outcome.connectionId} color={outcome.state === 'confirmed' ? 'teal' : 'orange'} title={proposal?.targets.find(target => target.connectionId === outcome.connectionId)?.name || outcome.connectionId}>{outcome.message}</Alert>)}</div>}
    </Modal>
  </section>;
}
