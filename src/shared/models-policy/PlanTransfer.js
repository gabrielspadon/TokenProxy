'use client';
import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Stack, Text, Textarea } from '@mantine/core';
import { policyRequest } from './policyModel';
import { preparePlanImport } from './planTransferModel';
import styles from './policy.module.css';

export function PlanTransfer({ disabled, onImported }) {
  const [text, setText] = useState(''), [exclude, setExclude] = useState(false), [review, setReview] = useState(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState(null), [uncertain, setUncertain] = useState(false);
  async function prepare() {
    setBusy(true); setFailure(null);
    try {
      const current = await policyRequest('/api/admin/configuration');
      setReview({ ...preparePlanImport(text, current.document, { excludeCapacityAdapter: exclude }), expectedCurrent: current.currentHash });
    } catch (error) { setFailure(error.message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!review || busy || uncertain) return;
    setBusy(true); setFailure(null);
    try {
      setUncertain(true);
      const stored = await policyRequest('/api/admin/configuration/drafts', 'POST', { document: review.document, expectedCurrent: review.expectedCurrent });
      const readback = await policyRequest(`/api/admin/configuration/drafts/${stored.id}`);
      if (readback.id !== stored.id || readback.revision !== stored.revision || readback.version.contentHash !== stored.version.contentHash) throw new Error('The exact imported draft could not be verified. Inspect stored drafts before creating another.');
      setUncertain(false); onImported(readback);
    } catch (error) { setFailure(error.message); if (error.status >= 400 && error.status < 500) setUncertain(false); }
    finally { setBusy(false); }
  }
  return <section className={styles.panelBody} aria-labelledby="plan-transfer-title"><Stack gap="md">
    <h2 id="plan-transfer-title">Import and export plans</h2>
    <Text>Download the legacy plan format or merge a version 1 or 2 export into a stored draft. Import matches exact plan names, keeps existing plan IDs and retains plans absent from the file. Activation requires the editor’s separate validation and review.</Text>
    <Button component="a" href="/api/combos/export" download="combos-export.json" variant="default">Download current plan export</Button>
    <Text size="sm">The export includes ordered models, plan kind, fallback strategy and judge model, plus capacity adapter settings when present. It excludes direct aliases, member account restrictions, fusion tuning and shaping settings. Existing restrictions and tuning remain on matching imported plans; validation catches references to removed members. This is not a complete configuration backup.</Text>
    {failure && <Alert color="orange" title={uncertain ? 'Draft outcome requires inspection' : 'Import not completed'}>{failure} Your pasted file is retained.</Alert>}
    <Textarea label="Plan export JSON" minRows={8} value={text} disabled={busy || !!review} onChange={event => setText(event.currentTarget.value)} />
    <Checkbox label="If present, exclude capacity adapter settings from this plan import." description="Capacity adapter settings are outside versioned routing-plan scope and remain unchanged. Review them in Capacity controls." checked={exclude} disabled={busy || !!review} onChange={event => setExclude(event.currentTarget.checked)} />
    {!review ? <Button disabled={disabled || !text.trim()} loading={busy} onClick={prepare}>Review plan import</Button> : <><h3>Review imported plans</h3><Text>{review.added.length} new · {review.updated.length} matching plans updated · {review.retained.length} other plans retained</Text><dl>{[['New plans', review.added], ['Updated plans', review.updated], ['Retained plans', review.retained]].map(([label, names]) => <div key={label}><dt>{label}</dt><dd>{names.join(', ') || 'None'}</dd></div>)}</dl>{review.excludedCapacityAdapter && <Alert color="orange">Capacity adapter settings in this file are excluded and will not change.</Alert>}<Text>Only a new draft is stored. Current routing, aliases, account policy, cache pins and shaping settings remain effective until a separately reviewed activation.</Text><Group><Button loading={busy} disabled={disabled || uncertain} onClick={save}>Store imported draft</Button><Button variant="default" disabled={busy || uncertain} onClick={() => setReview(null)}>Return to pasted file</Button></Group></>}
    {uncertain && <Text>Open History and receipts to inspect stored drafts. This uncertain submission cannot be replayed in this view.</Text>}
  </Stack></section>;
}
