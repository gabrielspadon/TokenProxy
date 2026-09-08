'use client';
import { useState } from 'react';
import { Confirm } from '@/shared/components/Confirm';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtUsd } from '@/shared/format';

const FIELDS = [
  ['maxPromptTokens', 'Prompt token ceiling', 'tokens'],
  ['maxCompletionTokens', 'Completion token ceiling', 'tokens'],
  ['maxCostUsd', 'Recorded cost ceiling', 'USD'],
  ['expiryDays', 'Expiry after adoption', 'days'],
];
const EMPTY = { name: '', allowedModels: '', budgetPolicy: 'strict', maxPromptTokens: '', maxCompletionTokens: '', maxCostUsd: '', expiryDays: '' };
const inputOf = profile => profile ? {
  ...profile, allowedModels: (profile.allowedModels || []).join(', '),
  ...Object.fromEntries(FIELDS.map(([field]) => [field, profile[field] ?? ''])),
} : EMPTY;

export function AccessProfiles({ poll, onKeysChanged }) {
  const profiles = poll.data?.profiles || [];
  const [selectedId, setSelectedId] = useState(null);
  const selected = profiles.find(profile => profile.id === selectedId);
  const [action, setAction] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const begin = (kind, profile) => {
    setError(null);
    setForm(inputOf(profile));
    setAction({ kind, profile });
    setReviewing(kind === 'delete');
  };
  const close = () => { if (!busy) { setReviewing(false); setError(null); if (action?.kind === 'delete') setAction(null); } };
  const refresh = async () => {
    const readback = await call('/api/access-profiles');
    if (!readback.ok || !Array.isArray(readback.body?.profiles)) {
      setReceipt({ tone: 'warn', title: 'The current profiles could not be verified.', next: 'Refresh before making another change.' });
      return;
    }
    setUncertain(false);
    poll.refresh();
    onKeysChanged();
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const deleting = action.kind === 'delete';
    const editing = action.kind === 'edit';
    const id = action.profile?.id;
    const payload = {
      name: form.name.trim(),
      allowedModels: form.allowedModels.split(/[,\n]/).map(value => value.trim()).filter(Boolean),
      budgetPolicy: form.budgetPolicy,
      ...Object.fromEntries(FIELDS.map(([field]) => [field, form[field] === '' ? null : Number(form[field])])),
      ...(editing ? { expectedVersion: action.profile.version, expectedName: action.profile.name } : {}),
    };
    const url = id ? `/api/access-profiles/${encodeURIComponent(id)}${deleting ? `?${new URLSearchParams({ expectedVersion: action.profile.version, expectedName: action.profile.name })}` : ''}` : '/api/access-profiles';
    const response = await call(url, { method: deleting ? 'DELETE' : editing ? 'PUT' : 'POST', ...(deleting ? {} : { body: payload }) });
    if (!response.ok) {
      setBusy(false);
      if (!response.status) {
        setAction(null);
        setUncertain(true);
        setReceipt({ tone: 'warn', title: 'The profile mutation outcome is unknown.', next: 'The connection ended before a response arrived. Refresh profiles before taking another action; do not resend the mutation.' });
        return;
      }
      setError(refusal(response.status, response.body));
      if (response.status === 409) poll.refresh();
      return;
    }
    const readback = await call('/api/access-profiles');
    const savedId = deleting ? id : response.body?.profile?.id;
    const retained = readback.body?.profiles?.find(profile => profile.id === savedId);
    const verified = readback.ok && Array.isArray(readback.body?.profiles) && (deleting
      ? !retained
      : retained?.version === response.body?.profile?.version && retained?.name === response.body?.profile?.name
        && [...FIELDS.map(([field]) => field), 'allowedModels', 'budgetPolicy'].every(field => JSON.stringify(retained?.[field]) === JSON.stringify(response.body?.profile?.[field])));
    setBusy(false);
    setAction(null);
    setUncertain(!verified);
    setSelectedId(deleting ? null : savedId);
    setReceipt(verified ? {
      tone: 'ok', title: deleting ? 'Profile deleted and absence verified.' : `Profile version ${retained.version} saved and verified.`,
      next: deleting ? 'Previously adopted key settings remain in place. Those keys are managed by hand.' : 'Existing keys keep their adopted settings. Select a key to adopt this version.',
    } : { tone: 'warn', title: 'The mutation was accepted; refreshed state was not verified.', next: 'Do not repeat the mutation. Refresh profiles to resolve the outcome.' });
    poll.refresh();
    onKeysChanged();
  };
  return (
    <section className="access-profiles" aria-labelledby="access-profiles-title">
      <div className="screen-head">
        <div><h2 id="access-profiles-title">Access profiles</h2><p className="caption">Versioned copies of limits, allowed models, and expiry. Editing a profile does not change a running client.</p></div>
        <button type="button" className="button" disabled={uncertain || busy || !!poll.error} onClick={() => begin('create')}>Create access profile</button>
      </div>
      {receipt ? <Notice {...receipt} /> : null}
      {poll.error ? <Notice {...refusal(poll.status, poll.error)} /> : null}
      {uncertain || poll.error ? <button type="button" className="button quiet" onClick={refresh}>Refresh profiles</button> : null}
      <div className="profile-workspace">
        <div className="profile-list" role="group" aria-label="Access profile inventory">
          {profiles.map(profile => <button type="button" key={profile.id} className="profile-row" aria-pressed={selectedId === profile.id} disabled={busy || uncertain} onClick={() => { setSelectedId(profile.id); begin('edit', profile); }}>
            <span>{profile.name}</span><span className="caption"><bdi>v{profile.version}</bdi> · {fmtNum(profile.keyCount)} keys · {profile.maxCostUsd === null ? 'No cost ceiling' : `${fmtUsd(profile.maxCostUsd)} lifetime ceiling`}</span>
          </button>)}
          {!profiles.length ? <p className="empty">No access profiles are defined. Create a reusable policy, then adopt it on each chosen key.</p> : null}
        </div>
        <aside className="profile-inspector" aria-label="Access profile inspector">
          {action && action.kind !== 'delete' ? <form onSubmit={event => { event.preventDefault(); setReviewing(true); }}><fieldset disabled={busy || uncertain || reviewing}>
            <h3>{action.kind === 'edit' ? `Edit ${action.profile.name} (v${action.profile.version})` : 'New access profile'}</h3>
        {action && action.kind !== 'delete' ? <div className="keys-form">
          <label className="field"><span>Profile name</span><input className="input" required maxLength={80} value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></label>
          {FIELDS.map(([field, label, unit]) => <label className="field" key={field}><span>{label} ({unit})</span><input className="input" type="number" min={field === 'expiryDays' ? 1 : 0} step={field === 'maxCostUsd' ? 'any' : 1} value={form[field]} onChange={event => setForm(value => ({ ...value, [field]: event.target.value }))} /></label>)}
          <label className="field"><span>Profile model allowlist</span><textarea className="input" value={form.allowedModels} onChange={event => setForm(value => ({ ...value, allowedModels: event.target.value }))} /></label>
          <p className="caption">Comma-separated model IDs or provider/*. Empty limits mean no ceiling; an empty model list permits every model.</p>
          <label className="field"><span>Profile budget protection</span><select className="select" value={form.budgetPolicy} onChange={event => setForm(value => ({ ...value, budgetPolicy: event.target.value }))}><option value="strict">Verified bounds</option><option value="reserve-remaining">Reserve remaining allowance</option></select></label>
          <p className="caption">Verified bounds refuses capped requests without a known upper bound. Reserve remaining allowance is best effort and actual usage may exceed the ceiling.</p>
        </div> : null}
            {error ? <Notice {...error} /> : null}
            <button type="submit" className="button">Review profile</button>
          </fieldset></form> : <p className="caption">Select a profile or create one to configure its limits.</p>}
          {selected ? <button type="button" className="button danger" disabled={busy || uncertain || !!poll.error} onClick={() => begin('delete', selected)}>Delete access profile</button> : null}
        </aside>
      </div>
      <Confirm open={!!action && reviewing} busy={busy} refusal={error} title={action?.kind === 'delete' ? 'Delete access profile' : action?.kind === 'edit' ? 'Edit access profile' : 'Create access profile'} verb={action?.kind === 'delete' ? 'Delete profile' : 'Save profile'}
        requires="A local operator session and the profile version shown when editing or deleting."
        changes={action?.kind === 'delete' ? `Deletes this profile and releases its ${action.profile.keyCount} adopting keys. Their copied limits and expiry remain unchanged.` : 'Stores a versioned policy. Existing keys keep their adopted settings until you deliberately adopt a newer version.'}
        undo={action?.kind === 'delete' ? 'The profile history cannot be restored. Create a new profile if needed.' : 'Edit the profile again. Existing keys have not been changed.'}
        irreversible={action?.kind === 'delete'} onConfirm={save} onClose={close}>
        <p>{action?.kind === 'delete' ? action.profile.name : form.name}</p>
        {action?.kind !== 'delete' ? <dl className="facts">{FIELDS.map(([field, label, unit]) => <div key={field}><dt>{label}</dt><dd>{form[field] === '' ? 'No requirement' : `${form[field]} ${unit}`}</dd></div>)}<dt>Models</dt><dd>{form.allowedModels || 'Every model'}</dd><dt>Budget protection</dt><dd>{form.budgetPolicy === 'strict' ? 'Verified bounds' : 'Reserve remaining allowance'}</dd></dl> : null}
      </Confirm>
    </section>
  );
}
