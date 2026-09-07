'use client';
import { useState } from 'react';
import { Button, Checkbox, NativeSelect } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';
import { CONTROLS } from './controlCatalog';

const fields = [{ override: 'enabled', name: 'Plan baseline gate', effect: 'Off disables the 15 supported stages unless an explicit stage value enables one.' }, ...CONTROLS.filter(control => control.override)];
const choice = value => value == null ? 'Inherit' : value ? 'On' : 'Off';
const choices = [{ value: 'inherit', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];

export function PlanOverrides({ globalSettings, onSettingsChanged }) {
  const plans = usePoll('/api/admin/shaping/plans', 30000);
  const [historyPage, setHistoryPage] = useState(1);
  const history = usePoll(`/api/admin/shaping/plan-receipts?page=${historyPage}&pageSize=20`, 30000);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const selected = plans.data?.plans?.find(plan => plan.name === name);
  const baseline = draft?.baseline || selected;
  function discard() { setDraft(null); setReviewing(false); setConsent(false); setUncertain(false); }
  function change(key, value) {
    const next = value === 'inherit' ? null : value === 'on';
    setDraft(previous => ({ baseline: previous?.baseline || selected, expectedSettings: previous?.expectedSettings || plans.data.settingsHash, patch: { ...previous?.patch, [key]: next } }));
    setConsent(false); setNotice(null);
  }
  async function save() {
    if (!draft || !consent || busy || uncertain) return;
    setBusy(true); setNotice(null);
    const result = await call('/api/admin/shaping/plans', { method: 'POST', body: { name: draft.baseline.name, patch: draft.patch, expectedCurrent: draft.baseline.currentHash, expectedSettings: draft.expectedSettings, consent: Object.keys(globalSettings || {}) } });
    if (!result.ok) {
      const isUncertain = result.status === 0 || result.status >= 500;
      setUncertain(isUncertain);
      setNotice({ tone: 'warn', title: result.status === 409 ? 'The plan or global settings changed. Refresh and review the draft again.' : isUncertain ? 'The save outcome is unknown. Inspect current settings before making another change.' : 'The plan change was refused.', detail: result.body?.code || result.body?.error });
      setBusy(false); return;
    }
    const returned = result.body?.receipt;
    const observed = await call('/api/admin/shaping/plans');
    const retained = returned ? await call(`/api/admin/shaping/plan-receipts/${returned.id}`) : null;
    const confirmed = result.status !== 207 && result.body?.persistence === 'confirmed' && observed.ok && observed.body?.plans?.find(plan => plan.name === draft.baseline.name)?.currentHash === (returned?.afterHash || result.body?.afterHash) && (!returned || retained?.ok && retained.body?.afterHash === returned.afterHash);
    setReceipt(retained?.ok ? retained.body : returned || null);
    setNotice({ tone: confirmed ? 'ok' : 'warn', title: confirmed ? 'Plan controls saved and verified from retained state.' : 'The save was accepted, but persisted readback is incomplete. Refresh before another change.' });
    if (confirmed) discard(); else setUncertain(true);
    plans.refresh(); history.refresh(); onSettingsChanged?.(); setBusy(false);
  }
  async function inspectReceipt(id) {
    if (!id) { setReceipt(null); return; }
    const read = await call(`/api/admin/shaping/plan-receipts/${id}`);
    if (read.ok) setReceipt(read.body);
    else setNotice({ tone: 'warn', title: 'This retained receipt could not be read.', detail: read.body?.code || read.body?.error });
  }
  return <section className="shaping-plan-overrides" aria-labelledby="shaping-plan-title">
    <div className="shaping-section-head"><h2 id="shaping-plan-title">Plan overrides</h2><Button variant="default" onClick={plans.refresh} disabled={busy}>Refresh plans</Button></div>
    <p>These 15 stage overrides apply to new requests entering the selected routing plan. The outermost declaration wins. Explicit stage values override the plan baseline gate. In-flight requests retain their settings.</p>
    <p>Privacy, memory, tool disclosure, adaptive cache lifetime and content-change permissions remain global. An enabled stage still needs its runtime prerequisites. Request opt-out remains separate.</p>
    {plans.error ? <Notice tone="warn" title="Plan controls could not be refreshed." detail={plans.error} /> : null}
    {notice ? <div role="status"><Notice {...notice} /></div> : null}
    <NativeSelect label="Routing plan" value={name} disabled={busy || !!draft} onChange={event => { setName(event.currentTarget.value); setReceipt(null); setNotice(null); }} data={[{ value: '', label: 'Choose a routing plan' }, ...(plans.data?.plans || []).map(plan => ({ value: plan.name, label: plan.name }))]} />
    {plans.data && !plans.data.plans.length ? <p>No routing plan exists. Create one in Routing before adding overrides.</p> : null}
    {name && !selected && !plans.loading ? <p role="status">This plan is absent from the latest read. The retained draft remains available; saving cannot recreate the plan.</p> : null}
    {baseline ? <>
      <div className="shaping-plan-fields" role="region" aria-label="Plan shaping controls" tabIndex={0}>{fields.map(field => {
        const value = draft && Object.hasOwn(draft.patch, field.override) ? draft.patch[field.override] : baseline.controls[field.override];
        return <NativeSelect key={field.override} label={field.name} description={field.override === 'enabled' ? field.effect : `${field.effect} Current resolved configuration is ${baseline.effective?.[field.key] ? 'on' : 'off'}; execution is not established.`} value={value == null ? 'inherit' : value ? 'on' : 'off'} disabled={reviewing || busy || uncertain} onChange={event => change(field.override, event.currentTarget.value)} data={choices} />;
      })}</div>
      {draft && !reviewing ? <Button mt="md" onClick={() => setReviewing(true)}>Review plan changes</Button> : null}
      {reviewing ? <div className="shaping-plan-review" aria-label="Review plan changes">
        <h3>Review changes for {draft.baseline.name}</h3>
        <dl>{Object.entries(draft.patch).map(([key, value]) => <div key={key}><dt>{fields.find(field => field.override === key)?.name}</dt><dd>{choice(draft.baseline.controls[key])} → {choice(value)}</dd></div>)}</dl>
        <p>Only this plan’s shaping overrides change. Restore the previous values here to reverse future behavior. Routing-policy rollback and global shaping rollback do not restore these overrides or already transformed content.</p>
        <Checkbox label="I consent to the content-changing stages permitted by these overrides and the current global permissions." checked={consent} disabled={busy || uncertain} onChange={event => setConsent(event.currentTarget.checked)} />
        <Button mt="md" onClick={save} loading={busy} disabled={!consent || uncertain || !globalSettings}>Save plan controls</Button>
        <Button mt="md" ml="sm" variant="default" disabled={busy || uncertain} onClick={() => { setReviewing(false); setConsent(false); }}>Edit draft</Button>
      </div> : null}
      {draft ? <Button mt="md" ml="sm" variant="subtle" disabled={busy} onClick={discard}>Discard draft and use latest read</Button> : null}
    </> : null}
    <NativeSelect mt="lg" label="Retained plan change" value={receipt?.id || ''} onChange={event => inspectReceipt(event.currentTarget.value)} data={[{ value: '', label: 'Choose a retained change' }, ...(history.data?.rows || []).map(row => ({ value: row.id, label: `${row.name} · ${row.createdAt} · ${row.id.slice(0, 8)}` }))]} />
    {history.error ? <Notice tone="warn" title="Plan change history could not be refreshed." detail={history.error} /> : null}
    {history.data ? <div className="actions"><p className="shaping-caption">Page {historyPage} · {history.data.pagination.total} retained changes</p><Button variant="subtle" disabled={historyPage <= 1} onClick={() => setHistoryPage(page => page - 1)}>Previous changes</Button><Button variant="subtle" disabled={historyPage >= history.data.pagination.pages} onClick={() => setHistoryPage(page => page + 1)}>Next changes</Button></div> : null}
    {receipt ? <details className="shaping-technical" open><summary>Retained plan change receipt</summary><dl className="shaping-control-facts"><div><dt>Plan</dt><dd>{receipt.name}</dd></div><div><dt>Receipt</dt><dd><code>{receipt.id}</code></dd></div><div><dt>Scope</dt><dd>{receipt.scope}</dd></div><div><dt>Recorded at</dt><dd>{receipt.createdAt}</dd></div></dl><p>Before and after values are retained with this receipt. Provider execution and earlier request content are outside its scope.</p><div className="shaping-plan-receipt">{fields.filter(field => Object.hasOwn(receipt.before, field.override) || Object.hasOwn(receipt.after, field.override)).map(field => <p key={field.override}>{field.name} · {choice(receipt.before[field.override])} → {choice(receipt.after[field.override])}</p>)}</div></details> : null}
  </section>;
}
