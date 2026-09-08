'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Measure } from '@/shared/components/Measure';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { useAuthStatus } from '@/store/authStatus';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit, fmtUsd } from '@/shared/format';
import { KeyBudget } from './KeyBudget';
import { KeyLifecycle } from './KeyLifecycle';
import { ClientSetup } from './ClientSetup';
import { AccessProfiles } from './AccessProfiles';
import { keyBudgetState } from './budget';
import { useSavedDraft } from '../connections/useSavedDraft';
import './styles.css';

// The three ceilings of §7, in the order the gateway checks them.
const CEILINGS = [
  { field: 'maxPromptTokens', used: 'promptTokens', label: 'Prompt tokens', render: fmtNum },
  {
    field: 'maxCompletionTokens',
    used: 'completionTokens',
    label: 'Completion tokens',
    render: fmtNum,
  },
  { field: 'maxCostUsd', used: 'costUsd', label: 'Cost', render: fmtUsd },
];

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

function keyState(k) {
  return keyBudgetState(k).state;
}

function parseModels(text) {
  const list = String(text || '')
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function numberOrNull(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function LimitFields({ form, set }) {
  return (
    <>
      {CEILINGS.map((c) => (
        <label className="field" key={c.field}>
          <span>{c.label} ceiling</span>
          <input
            className="input"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={form[c.field]}
            onChange={(e) => set(c.field, e.target.value)}
          />
        </label>
      ))}
      <label className="field">
        <span>Model allowlist</span>
        <input
          className="input"
          type="text"
          value={form.allowedModels}
          onChange={(e) => set('allowedModels', e.target.value)}
        />
      </label>
      <p className="caption">
        One model id per entry, separated by commas. A whole provider is written as its name
        followed by a slash and a star. Leave empty for every model.
      </p>
      <label className="field">
        <span>Budget protection</span>
        <select
          className="input"
          value={form.budgetPolicy}
          onChange={(event) => set('budgetPolicy', event.target.value)}
        >
          <option value="strict">Verified bounds</option>
          <option value="reserve-remaining">Reserve remaining allowance</option>
        </select>
      </label>
      <p className="caption">
        {form.budgetPolicy === 'strict'
          ? 'A capped request is refused when its maximum use cannot be verified. Missing recorded usage also prevents admission for that resource.'
          : 'An unknown-bound request holds the remaining allowance and prevents overlapping exposure. Actual usage can exceed the allowance. This is best-effort protection.'}{' '}
        Policy changes apply to subsequent requests. Existing reservations and uncertain outcomes
        stay held. Recorded costs are estimates, not a provider invoice guarantee.
      </p>
    </>
  );
}

const BLANK = {
  name: '',
  expiresAt: '',
  maxPromptTokens: '',
  maxCompletionTokens: '',
  maxCostUsd: '',
  allowedModels: '',
  budgetPolicy: 'strict',
  // No default overlap. Choosing one for the operator is choosing when their
  // client's traffic breaks.
  overlapHours: '',
  profileId: '',
};

export default function KeysPage() {
  const keys = usePoll('/api/keys', 15000);
  const devices = usePoll('/api/keys/devices', 0);
  const settings = usePoll('/api/settings', 30000);
  const accessProfiles = usePoll('/api/access-profiles', 0);
  const auth = useAuthStatus((s) => s.status);
  const [selectedId, setSelectedId] = useState(null);
  const [keyTask, setKeyTask] = useState('policy');
  const [setupVisited, setSetupVisited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [created, setCreated] = useState(null);
  const actionEpoch = useRef(0);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [result, setResult] = useState(null);
  const [verifiedKeys, setVerifiedKeys] = useState(null);
  const [picked, setPicked] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const currentKeys = verifiedKeys?.source === keys.data ? verifiedKeys.data : keys.data;
  const rows = useMemo(() => currentKeys?.keys || [], [currentKeys]);
  const profiles = useMemo(() => accessProfiles.data?.profiles || [], [accessProfiles.data]);
  const close = useCallback(() => {
    actionEpoch.current++;
    setAction(null);
    setRefused(null);
    setCreated(null);
    setCopied(false);
    setForm(BLANK);
    setBusy(false);
  }, []);

  useEffect(
    () => () => {
      actionEpoch.current++;
    },
    []
  );
  useEffect(() => {
    if (!created?.key) return;
    const timeout = setTimeout(close, 60000);
    const hide = () => {
      if (document.visibilityState === 'hidden') close();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [created, close]);

  const open = (kind, key, draft, editedFields) => {
    actionEpoch.current++;
    setRefused(null);
    setResult(null);
    setCreated(null);
    setCopied(false);
    setForm(
      draft || (kind === 'limits' && key
        ? {
            ...BLANK,
            maxPromptTokens: key.maxPromptTokens ?? '',
            maxCompletionTokens: key.maxCompletionTokens ?? '',
            maxCostUsd: key.maxCostUsd ?? '',
            allowedModels: (key.allowedModels || []).join(', '),
            budgetPolicy: key.budget?.policy || key.effectiveBudgetPolicy || 'reserve-remaining',
          }
        : kind === 'expiry' && key
          ? { ...BLANK, expiresAt: key.expiresAt?.slice(0, 19) || '' }
          : BLANK)
    );
    setAction({ kind, key, editedFields });
  };

  const renderFields = (action, form, set) => <>
        {action?.kind === 'create' ? (
          <div className="keys-form">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Expires on</span>
              <input
                className="input"
                type="date"
                value={form.expiresAt}
                onChange={(e) => set('expiresAt', e.target.value)}
              />
            </label>
            <p className="caption">Leave empty and the key never expires.</p>
            <LimitFields form={form} set={set} />
          </div>
        ) : null}
        {action?.kind === 'limits' ? (
          <div className="keys-form">
            <LimitFields form={form} set={set} />
          </div>
        ) : null}
        {action?.kind === 'expiry' ? (
          <div className="keys-form">
            <label className="field"><span>Expiry in UTC</span><input className="input" type="datetime-local" step="1" value={form.expiresAt} onChange={event => set('expiresAt', event.target.value)} /></label>
            <p className="caption">All fields are UTC. Leave empty for no expiry. The previous expiry was <bdi>{action.key.expiresAt || 'not set'}</bdi>.</p>
          </div>
        ) : null}
        {action?.kind === 'rotate' ? (
          <div className="keys-form">
            <label className="field">
              <span>Overlap window in hours</span>
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={form.overlapHours}
                onChange={(e) => set('overlapHours', e.target.value)}
              />
            </label>
            <p className="caption">
              How long this key keeps working after the successor is issued. Choose enough time to
              reconfigure every client that uses it. Zero stops this key immediately, which is for
              responding to a leak. A window is never chosen for you.
            </p>
            {action.key?.expiresAt ? (
              <p className="caption">
                This key already expires{' '}
                <span>{fmtRelative(action.key.expiresAt, now)}</span>. A longer
                window does not extend it.
              </p>
            ) : null}
          </div>
        ) : null}
        {action?.kind === 'adopt' ? (
          <div className="keys-form">
            <label className="field">
              <span>Access profile</span>
              <select
                className="input"
                value={form.profileId}
                onChange={(e) => set('profileId', e.target.value)}
              >
                <option value="">Follow no profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (v{p.version})
                  </option>
                ))}
              </select>
            </label>
            <p className="caption">
              {profiles.length
                ? "Adopting copies the profile's settings onto this key. The key keeps them if the profile later changes or is deleted, and reports as behind or drifted rather than changing under a running client."
                : 'No access profile is defined yet. A profile is a named, versioned bundle of ceilings, allowlist and budget policy that several keys can follow.'}
            </p>
          </div>
        ) : null}
  </>;
  const keyForm = (kind, key, title, seed) => <KeyTaskForm key={`${key?.id || 'new'}-${kind}`} title={title} seed={seed} disabled={busy || Boolean(action)} onReview={(draft, editedFields) => open(kind, key, draft, editedFields)}>
    {(draft, setDraft) => renderFields({ kind, key }, draft, setDraft)}
  </KeyTaskForm>;

  const limitsBody = () => ({
    maxPromptTokens: numberOrNull(form.maxPromptTokens),
    maxCompletionTokens: numberOrNull(form.maxCompletionTokens),
    maxCostUsd: numberOrNull(form.maxCostUsd),
    allowedModels: parseModels(form.allowedModels),
    budgetPolicy: form.budgetPolicy,
  });

  const run = async () => {
    if (!action) return;
    if (created) {
      close();
      return;
    }
    if (action.kind === 'limits' || action.kind === 'expiry') {
      const current = rows.find(key => key.id === action.key.id);
      const fields = action.kind === 'limits' ? action.editedFields : ['expiresAt'];
      const value = (key, field) => field === 'budgetPolicy' ? key?.budget?.policy || key?.effectiveBudgetPolicy || 'reserve-remaining' : key?.[field] ?? null;
      if (!current || fields.some(field => JSON.stringify(value(current, field)) !== JSON.stringify(value(action.key, field)))) {
        setRefused({ tone: 'warn', title: 'Saved key fields changed after this review opened.', next: 'Cancel this review and load the current saved values. Your edited draft is retained.' });
        return;
      }
    }
    setBusy(true);
    setRefused(null);
    const k = action.key;
    const epoch = actionEpoch.current;
    let res;
    if (action.kind === 'create') {
      res = await call('/api/keys', {
        method: 'POST',
        body: { name: form.name.trim(), expiresAt: form.expiresAt || null, ...limitsBody() },
      });
    } else if (action.kind === 'reveal') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}/reveal`, { method: 'POST' });
    } else if (action.kind === 'limits') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PUT',
        body: Object.fromEntries(Object.entries(limitsBody()).filter(([field]) => action.editedFields.includes(field))),
      });
    } else if (action.kind === 'expiry') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PUT', body: { expiresAt: form.expiresAt ? new Date(`${form.expiresAt}Z`).toISOString() : null },
      });
    } else if (action.kind === 'activate' || action.kind === 'deactivate') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PUT',
        body: { isActive: action.kind === 'activate' },
      });
    } else if (action.kind === 'rotate') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}/rotate`, {
        method: 'POST',
        body: { overlapHours: numberOrNull(form.overlapHours) },
      });
    } else if (action.kind === 'adopt') {
      res = form.profileId
        ? await call(`/api/keys/${encodeURIComponent(k.id)}/profile`, {
            method: 'POST',
            body: { profileId: form.profileId },
          })
        : await call(`/api/keys/${encodeURIComponent(k.id)}/profile`, { method: 'DELETE' });
    } else if (action.kind === 'revoke') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
    } else {
      const q = picked.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      res = await call(`/api/keys?${q}`, { method: 'DELETE' });
    }
    if (epoch !== actionEpoch.current) return;
    setBusy(false);
    if (!res.ok) {
      if (!res.status) {
        setRefused({ tone: 'warn', title: 'The key mutation outcome is unknown.', next: 'Close and refresh the key list before taking another action. Do not repeat an interrupted create, rotation or other mutation.' });
        setBusy(true);
        keys.refresh();
        return;
      }
      setRefused(refusal(res.status, res.body));
      return;
    }
    keys.refresh();
    if (action.kind === 'adopt') {
      setBusy(true);
      const readback = await call('/api/keys');
      if (epoch !== actionEpoch.current) return;
      const saved = readback.body?.keys?.find(key => key.id === k.id);
      const expected = res.body?.key;
      const fields = ['maxPromptTokens', 'maxCompletionTokens', 'maxCostUsd', 'allowedModels', 'expiresAt', 'budgetPolicy', 'accessProfileId', 'accessProfileVersion'];
      if (!readback.ok || expected?.id !== k.id || !saved || !fields.every(field => JSON.stringify(saved[field] ?? null) === JSON.stringify(expected[field] ?? null))) {
        setRefused({ tone: 'warn', title: 'The profile change was accepted; refreshed key settings were not verified.', next: 'Close and refresh the key before another change. Do not repeat the adoption.' });
        return;
      }
      setVerifiedKeys({ data: readback.body, source: keys.data });
      setBusy(false);
    }
    if (action.kind === 'expiry') {
      setBusy(true);
      const readback = await call(`/api/keys/${encodeURIComponent(k.id)}`);
      if (epoch !== actionEpoch.current) return;
      const expected = form.expiresAt ? new Date(`${form.expiresAt}Z`).toISOString() : null;
      if (!readback.ok || readback.body?.key?.expiresAt !== expected) {
        setRefused({ tone: 'warn', title: 'The expiry change was accepted; readback was not verified.', next: 'Close this dialog and refresh the key before making another change. Do not repeat the mutation.' });
        return;
      }
      setBusy(false);
    }
    if (action.kind === 'create' || action.kind === 'reveal') {
      setCreated(res.body);
      return;
    }
    // A rotation hands back the successor's secret exactly once, so it goes
    // through the same show-once path as a freshly created key.
    if (action.kind === 'rotate') {
      setCreated({ ...res.body.successor, rotation: res.body });
      accessProfiles.refresh();
      return;
    }
    if (action.kind === 'revokeSelected') {
      setPicked([]);
      setResult(
        res.body.deleted === res.body.requested
          ? { tone: 'ok', title: 'Revoked.' }
          : {
              tone: 'warn',
              title: 'Revoked what was still there.',
              next: 'The rest were already gone. Nothing else changed.',
            }
      );
    } else {
      setResult({
        tone: 'ok',
        title: {
          limits: 'Saved.',
          expiry: 'Expiry saved and verified.',
          adopt: form.profileId ? 'Profile adopted.' : 'No longer following a profile.',
          activate: 'Activated.',
          deactivate: 'Deactivated.',
          revoke: 'Revoked.',
        }[action.kind],
      });
    }
    close();
  };

  const copy = async () => {
    if (!created?.key) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const windowMinutes = devices.data?.windowMinutes;
  const requireApiKey = settings.data?.requireApiKey;
  const requireLogin = settings.data?.requireLogin;
  const toggleKeyRequirement = async () => {
    setResult(null);
    const res = await call('/api/settings', {
      method: 'PATCH',
      body: { requireApiKey: !requireApiKey },
    });
    if (!res.ok) {
      setResult(refusal(res.status, res.body));
      return;
    }
    settings.refresh();
  };

  const COPY = {
    reveal: {
      title: `Reveal ${action?.key?.name || 'this key'}`,
      verb: 'Reveal',
      requires: 'An operator session.',
      changes:
        'Sends this credential to your browser for client setup. Its activation, expiry and limits stay as configured.',
      undo: 'Close the dialog to clear the displayed value. If copied, it remains on your clipboard.',
    },
    create: {
      title: 'Create a key',
      verb: 'Create',
      requires:
        'An operator session. The key is issued for the machine that runs the gateway, which you cannot choose.',
      changes:
        'Issues a new key that can route inference immediately, under whatever ceilings you set here.',
      undo: 'Revoke the key. What it spent stays on the record.',
    },
    limits: {
      title: 'Save limits',
      verb: 'Save',
      requires: 'An operator session.',
      changes:
        "Replaces this key's three ceilings and its model allowlist. A ceiling counts everything the key has ever spent, not spending from now on, so a key already past a new ceiling stops on its next use.",
      undo: 'Set them again. Nothing already spent is affected.',
    },
    activate: {
      title: 'Activate this key',
      verb: 'Activate',
      requires: 'An operator session.',
      changes: 'Lets this key authenticate again from its next use. Its value does not change.',
      undo: 'Deactivate it again.',
    },
    expiry: {
      title: 'Change key expiry', verb: 'Save expiry', requires: 'An operator session.',
      changes: 'Replaces the UTC expiry for this key. A past date refuses it on its next use. Clearing the date removes the expiry, including an expiry set by rotation.',
      undo: 'Restore the previous expiry date. In-flight responses are not interrupted.',
    },
    deactivate: {
      title: 'Deactivate this key',
      verb: 'Deactivate',
      requires: 'An operator session.',
      changes:
        'Stops this key authenticating on its next use. Its value and its usage record are kept.',
      undo: 'Activate it again.',
    },
    rotate: {
      title: `Rotate ${action?.key?.name || 'this key'}`,
      verb: 'Rotate',
      requires: 'An operator session.',
      changes:
        "Issues a new key carrying this one's ceilings, allowlist and profile, and gives this one an expiry at the end of the overlap window you choose. This key keeps working until then, so a client you have not reconfigured is not cut off. The new value is shown once.",
      undo: 'Revoke the successor. This key keeps whatever expiry the rotation gave it, which you can then clear by editing it.',
    },
    adopt: {
      title: `Access profile for ${action?.key?.name || 'this key'}`,
      verb: 'Apply',
      requires: 'An operator session.',
      changes:
        "Copies the chosen profile's current ceilings, allowlist and budget policy onto this key, replacing what is set now. Choosing no profile leaves every setting exactly as it is and only stops the key being tracked against a profile.",
      undo: 'Adopt a different profile, or edit the limits by hand. Nothing already spent is affected.',
    },
    revoke: {
      title: 'Revoke this key',
      verb: 'Revoke',
      requires: 'An operator session.',
      changes:
        'Destroys the key and its model allowlist. Every client still using it is refused from that moment. Its usage record is kept.',
      undo: 'None. A revoked key cannot be restored, and a replacement has a different value.',
      irreversible: true,
    },
    revokeSelected: {
      title: 'Revoke the selected keys',
      verb: 'Revoke',
      requires: 'An operator session.',
      changes:
        'Destroys every selected key and its model allowlist in one step. Every client still using any of them is refused from that moment.',
      undo: 'None. A revoked key cannot be restored, and a replacement has a different value.',
      irreversible: true,
    },
  };
  const copyFor = action ? COPY[action.kind] : null;

  return (
    <>
      <div className="screen-head">
        <h1>Keys</h1>
        <Freshness status={pollFresh(keys)} lastDataAt={keys.goodAt} />
      </div>

      <div className="measures keys-summary">
        <Measure
          big
          label="Keys issued"
          measure={keys.data ? { value: rows.length } : null}
          render={fmtNum}
        />
        <Measure
          big
          label="Enabled"
          measure={keys.data ? { value: rows.filter((k) => keyState(k) === 'on').length } : null}
          render={fmtNum}
        />
        <Measure
          big
          label="Clients seen"
          measure={keys.data ? { value: rows.reduce((n, k) => n + (k.deviceCount || 0), 0) } : null}
          render={fmtNum}
        />
        <Measure
          big
          label="Requests"
          measure={
            keys.data && rows.every((k) => Number.isFinite(k.usage?.requests))
              ? { value: rows.reduce((n, k) => n + ((k.usage || {}).requests || 0), 0) }
              : null
          }
          render={fmtNum}
        />
      </div>



      <section aria-labelledby="h-keys">
        <p className="caption">
          {keys.data?.usageState === 'unavailable'
            ? 'Historical usage is temporarily unavailable. Current key controls and budget reservations remain available.'
            : keys.data?.usageFreshness?.source === 'last-persisted-snapshot'
              ? `History reflects the persisted database snapshot from ${keys.data.usageFreshness.persistedAt}.`
              : keys.data?.usageFreshness?.snapshotCompletedAt
                ? `History was read at ${keys.data.usageFreshness.snapshotCompletedAt}.`
                : 'Historical usage has not been reported.'}
        </p>
        <div className="screen-head">
          <h2 id="h-keys">Client keys</h2>
          <button type="button" className="button" onClick={() => setCreating(value => !value)}>
            <Icon name="i-add" />
            Create a key
          </button>
        </div>
        <p>
          A client key authenticates a downstream caller against this gateway&apos;s inference
          surface. It never reaches an upstream provider account of its own.
        </p>
        {result ? <Notice {...result} /> : null}
        {keys.error && !keys.data ? <Notice {...refusal(keys.status, keys.error)} /> : null}
        {keys.loading && !keys.data ? <p className="skeleton">Reading</p> : null}
        {keys.data && rows.length === 0 ? (
          <p className="empty">
            No key is issued. Create one to let a tool route through this gateway.
          </p>
        ) : null}
        {rows.length ? (
          <>
            <div className="rows">
              <div className="row head keys-row">
                <span>Key</span>
                <span>Clients</span>
                <span>State</span>
              </div>
              {rows.map((k) => {
                const st = keyState(k);
                const budgetState = keyBudgetState(k);
                const on = picked.includes(k.id);
                return (
                  <div className="row keys-row" key={k.id}>
                    <span className="who">
                      <label className="keys-pick">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setPicked((p) => (on ? p.filter((id) => id !== k.id) : [...p, k.id]))
                          }
                        />
                        <span className="name">{k.name}</span>
                      </label>
                      <button type="button" className="button quiet" aria-pressed={selectedId === k.id} onClick={() => { if (selectedId !== k.id) setSetupVisited(false); setSelectedId(k.id); setKeyTask('policy'); }}>Configure {k.name}</button>
                      <span className="sub">
                        <span className="id">
                          {k.id}
                        </span>
                        {k.keyPreview ? (
                          <span className="id">
                            {' '}
                            {k.keyPreview}
                          </span>
                        ) : null}
                        {k.createdAt ? (
                          <>
                            {' '}
                            <span>Created</span>{' '}
                            <span>{fmtRelative(k.createdAt, now)}</span>
                          </>
                        ) : null}
                        {k.expiresAt ? (
                          <>
                            {' '}
                            <span>Expires</span>{' '}
                            <span>{fmtRelative(k.expiresAt, now)}</span>
                          </>
                        ) : (
                          <>
                            {' '}
                            <span>Never expires</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span>{fmtNum(k.deviceCount || 0)}</span>
                    <span className="status" data-tone={budgetState.tone} data-state={st}>
                      {budgetState.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="caption">
              A client is one address and tool seen on the key inside a recent window, counted in
              memory and reset when the gateway restarts.
              {windowMinutes ? (
                <>
                  {' '}
                  <span>Window</span> <span>{fmtUnit(windowMinutes, 'minute')}</span>
                  .
                </>
              ) : null}
            </p>
            <div className="verb-row">
              <button
                type="button"
                className="button danger"
                disabled={picked.length === 0}
                onClick={() => open('revokeSelected')}
              >
                <Icon name="i-delete" />
                Revoke selected
              </button>
              {picked.length ? (
                <span className="caption">
                  <span>{fmtNum(picked.length)}</span> <span>selected</span>
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      {creating ? <section aria-label="Create a key">{keyForm('create', null, 'Create a key', BLANK)}</section> : null}
      {rows.find(key => key.id === selectedId) ? (() => {
        const key = rows.find(item => item.id === selectedId);
        return <section aria-label="Selected key configuration" key={key.id}>
          <div className="screen-head"><h2>{key.name}</h2><button type="button" className="button quiet" onClick={() => setSelectedId(null)}>Close key</button></div>
          <nav className="verb-row" aria-label="Key tasks">{[['policy', 'Policy'], ['setup', 'Client setup']].map(([value, label]) => <button type="button" key={value} className={keyTask === value ? 'button' : 'button quiet'} aria-pressed={keyTask === value} onClick={() => { setKeyTask(value); if (value === 'setup') setSetupVisited(true); }}>{label}</button>)}</nav>
          {setupVisited ? <div hidden={keyTask !== 'setup'}><ClientSetup record={key} /></div> : null}
          <div hidden={keyTask !== 'policy'}>
            <KeyBudget record={key} />
            <KeyLifecycle record={key} profiles={profiles} now={now} />
            {keyForm('limits', key, 'Key budgets and model access', { ...BLANK, maxPromptTokens: key.maxPromptTokens ?? '', maxCompletionTokens: key.maxCompletionTokens ?? '', maxCostUsd: key.maxCostUsd ?? '', allowedModels: (key.allowedModels || []).join(', '), budgetPolicy: key.budget?.policy || key.effectiveBudgetPolicy || 'reserve-remaining' })}
            {keyForm('expiry', key, 'Key expiry', { ...BLANK, expiresAt: key.expiresAt?.slice(0, 19) || '' })}
            {keyForm('adopt', key, 'Access profile', { ...BLANK, profileId: key.profile?.profileId || '' })}
            {!key.supersededAt ? keyForm('rotate', key, 'Rotate key', BLANK) : null}
          </div>
          <div className="verb-row">
            <button type="button" className="button quiet" onClick={() => open('reveal', key)}>Reveal key</button>
            <button type="button" className="button quiet" onClick={() => open(key.isActive ? 'deactivate' : 'activate', key)}>{key.isActive ? 'Deactivate' : 'Activate'}</button>
            <button type="button" className="button danger" onClick={() => open('revoke', key)}>Revoke</button>
          </div>
        </section>;
      })() : null}
      <AccessProfiles poll={accessProfiles} onKeysChanged={keys.refresh} />

      <section aria-labelledby="h-who">
        <h2 id="h-who">Who may do what</h2>
        <div>
          <p>Two classes of caller reach this gateway and they never overlap.</p>
          <dl className="facts">
            <dt>Inference caller</dt>
            <dd>
              Holds a client key above and may route inference. It can never read or change
              connections, quota, drain, releases, the catalog, or spend accounting, whichever key
              it holds.
            </dd>
            <dt>Operator</dt>
            <dd>
              Signed in here, or holding the command-line token tied to this machine. Only an
              operator reads or changes any of that, and the key configuration on this screen.
            </dd>
            <dt>Either, or neither</dt>
            <dd>
              Liveness and the plain model catalog answer a client key, an operator, or a caller on
              this machine with no credential at all, because a caller needs both before it has an
              identity.
            </dd>
            <dt>You</dt>
            <dd>
              {auth?.authenticated ? (
                <>
                  <span className="status" data-tone="ok">
                    Operator
                  </span>
                  {auth.displayName ? (
                    <>
                      {' '}
                      <span>{auth.displayName}</span>
                    </>
                  ) : null}
                </>
              ) : auth?.requireLogin === false ? (
                <span className="status" data-tone="warn">
                  Sign-in is turned off, so anything that reaches this port is treated as the
                  operator
                </span>
              ) : (
                <span className="unreported">Not reported</span>
              )}
            </dd>
          </dl>
          <ul className="bullets">
            <li>
              A caller holding only an inference key that reaches an operator action is told it
              holds the wrong kind of credential, which is a different answer from holding none.
            </li>
            <li>
              Every action that changes state must arrive from this machine, directly or through a
              tunnel that ends as a local connection. The right operator credential from elsewhere
              is still refused.
            </li>
            <li>
              A refused request changes nothing at all. Every other fact reads exactly as it did the
              moment before the attempt.
            </li>
          </ul>
        </div>
      </section>

      <section className="keys-decisions" aria-labelledby="h-decisions">
        <div className="screen-head">
          <h2 id="h-decisions">Decisions</h2>
          <Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} />
        </div>
        {settings.error && !settings.data ? (
          <Notice {...refusal(settings.status, settings.error)} />
        ) : null}
        <dl className="facts">
          <dt>Client key required</dt>
          <dd>
            {requireApiKey === undefined ? (
              <span className="unreported">Not reported</span>
            ) : (
              <>
                <span className="status" data-tone={requireApiKey ? 'ok' : 'warn'}>
                  {requireApiKey
                    ? 'Every inference request must carry a key'
                    : 'Inference is served without a key'}
                </span>{' '}
                <button type="button" className="link-button" onClick={toggleKeyRequirement}>
                  {requireApiKey ? 'Stop requiring a key' : 'Require a key'}
                </button>
              </>
            )}
          </dd>
          <dt>Operator sign-in required</dt>
          <dd>
            {requireLogin === undefined ? (
              <span className="unreported">Not reported</span>
            ) : (
              <span className="status" data-tone={requireLogin ? 'ok' : 'warn'}>
                {requireLogin ? 'A session is required' : 'Sign-in is turned off'}
              </span>
            )}{' '}
            <Link href="/dashboard/access" prefetch={false}>
              Change it under Access
            </Link>
          </dd>
          <dt>Operator access over a tunnel</dt>
          <dd>
            <Link href="/dashboard/remote" prefetch={false}>
              Decided under Remote
            </Link>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="h-keys-gap">
        <h2 id="h-keys-gap">Check model permission</h2>
        <p>
          Open Client setup for a key and name a model to check its current allowlist, expiry,
          enabled state and ceilings locally. This does not establish provider entitlement,
          available quota or a successful model response.
        </p>
      </section>

      <p className="caption">
        Key lists contain masked previews. Revealing a stored credential requires an explicit
        operator action on that key, even when dashboard sign-in is turned off.
      </p>

      <Confirm
        open={!!action}
        busy={busy}
        refusal={refused}
        title={
          created ? (action?.kind === 'reveal' ? 'Key revealed' : 'Key created') : copyFor?.title
        }
        verb={created ? 'Done' : copyFor?.verb}
        requires={created ? 'An operator session.' : copyFor?.requires}
        changes={
          created
            ? 'This credential is visible temporarily. Its configured activation, expiry and limits govern subsequent requests.'
            : copyFor?.changes
        }
        undo={
          created
            ? 'Close the dialog to clear the displayed value. Copied values remain on your clipboard.'
            : copyFor?.undo
        }
        irreversible={!created && !!copyFor?.irreversible}
        onConfirm={run}
        onClose={close}
      >
        {!created && action ? <p>{action.key?.name || form.name || 'Selected keys'}</p> : null}
        {!created && action?.kind === 'rotate' ? <p>Overlap window · {form.overlapHours} hours</p> : null}
        {!created && ['create', 'limits'].includes(action?.kind) ? <dl className="facts">{CEILINGS.map(ceiling => <div key={ceiling.field}><dt>{ceiling.label} ceiling</dt><dd>{form[ceiling.field] === '' ? 'No ceiling' : String(form[ceiling.field])}</dd></div>)}<dt>Model allowlist</dt><dd>{form.allowedModels || 'Every model'}</dd><dt>Budget protection</dt><dd>{form.budgetPolicy === 'strict' ? 'Verified bounds' : 'Reserve remaining allowance'}</dd></dl> : null}
        {!created && action?.kind === 'adopt' ? <p>Access profile · {profiles.find(profile => profile.id === form.profileId)?.name || 'Follow no profile'}</p> : null}
        {!created && action?.kind === 'expiry' ? <p>Expiry in UTC · {form.expiresAt || 'No expiry'}</p> : null}
        {created ? (
          <div className="keys-once">
            <p>
              This value clears after 60 seconds, when you leave this tab, or when you close the
              dialog. Use Reveal key to retrieve it again.
            </p>
            {created.rotation ? (
              <p className="caption">
                This is the successor key. The previous one keeps working until{' '}
                <span>{fmtRelative(created.rotation.overlapEndsAt, now)}</span>
                {created.rotation.overlapTruncatedByExistingExpiry
                  ? ', which is its own existing expiry rather than the window you chose.'
                  : '.'}
              </p>
            ) : null}
            <code className="keys-secret">
              {created.key}
            </code>
            <div className="actions">
              <button type="button" className="button quiet" onClick={copy}>
                <Icon name="i-copy" />
                Copy
              </button>
              {copied ? <span className="caption">Copied.</span> : null}
            </div>
          </div>
        ) : null}
      </Confirm>
    </>
  );
}

function KeyTaskForm({ title, seed, disabled, onReview, children }) {
  const { values, set, reset, conflicts, editedFields } = useSavedDraft(seed);
  return <section className="panel key-task-form"><h3>{title}</h3><form onSubmit={event => { event.preventDefault(); if (!disabled && !conflicts.length) onReview(values, editedFields); }}><fieldset disabled={disabled}>
    {children(values, set)}
    {conflicts.length ? <Notice tone="warn" title="Saved key fields changed while you were editing." next={`Your draft is retained. Load saved values before reviewing. Changed fields: ${conflicts.join(', ')}.`} /> : null}
    <div className="verb-row"><button type="button" className="button quiet" onClick={reset}>Load saved values</button><button type="submit" className="button" disabled={conflicts.length > 0}>Review {title.toLowerCase()}</button></div>
  </fieldset></form></section>;
}
