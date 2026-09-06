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
import './styles.css';

const STATE_WORD = { on: 'Active', off: 'Deactivated', expired: 'Expired', over: 'Over a ceiling' };
const STATE_TONE = { on: 'ok', off: 'warn', expired: 'warn', over: 'bad' };

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

// Mirrors exceededLimit in src/lib/db/repos/apiKeysRepo.js: at the ceiling is
// over it, and the first one reached is the one reported.
function exceeded(k) {
  const u = k.usage || {};
  for (const c of CEILINGS) {
    if (k[c.field] != null && (u[c.used] || 0) >= k[c.field]) return c;
  }
  return null;
}

function keyState(k) {
  if (!k.isActive) return 'off';
  if (k.isExpired) return 'expired';
  if (exceeded(k)) return 'over';
  return 'on';
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

function Ceiling({ ceiling, limit, used }) {
  if (limit == null) {
    return (
      <div className="keys-ceiling">
        <span className="label">{ceiling.label}</span>
        <span className="keys-ceiling-value">
          <span className="unreported">No ceiling</span>
        </span>
        <span className="caption">
          <span data-i18n-skip>{ceiling.render(used)}</span> <span>spent</span>
        </span>
      </div>
    );
  }
  const over = used >= limit;
  const frac = limit > 0 ? Math.min(1, used / limit) : 1;
  return (
    <div className="keys-ceiling">
      <span className="label">{ceiling.label}</span>
      <div
        className="band"
        data-level={over ? 'empty' : frac > 0.85 ? 'low' : undefined}
        aria-hidden="true"
      >
        <span className="used" style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="band-meta">
        <span data-i18n-skip>
          {ceiling.render(used)} / {ceiling.render(limit)}
        </span>
        {limit === 0 ? <span>Frozen at zero</span> : over ? <span>Over</span> : null}
      </span>
    </div>
  );
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
};

export default function KeysPage() {
  const keys = usePoll('/api/keys', 15000);
  const devices = usePoll('/api/keys/devices', 0);
  const settings = usePoll('/api/settings', 30000);
  const auth = useAuthStatus((s) => s.status);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [created, setCreated] = useState(null);
  const actionEpoch = useRef(0);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => keys.data?.keys || [], [keys.data]);
  const set = useCallback((field, value) => setForm((f) => ({ ...f, [field]: value })), []);
  const close = useCallback(() => {
    actionEpoch.current++;
    setAction(null);
    setRefused(null);
    setCreated(null);
    setCopied(false);
    setForm(BLANK);
    setBusy(false);
  }, []);

  useEffect(() => () => { actionEpoch.current++; }, []);
  useEffect(() => {
    if (!created?.key) return;
    const timeout = setTimeout(close, 60000);
    const hide = () => { if (document.visibilityState === 'hidden') close(); };
    document.addEventListener('visibilitychange', hide);
    return () => { clearTimeout(timeout); document.removeEventListener('visibilitychange', hide); };
  }, [created, close]);

  const open = (kind, key) => {
    actionEpoch.current++;
    setRefused(null);
    setResult(null);
    setCreated(null);
    setCopied(false);
    setForm(
      kind === 'limits' && key
        ? {
            ...BLANK,
            maxPromptTokens: key.maxPromptTokens ?? '',
            maxCompletionTokens: key.maxCompletionTokens ?? '',
            maxCostUsd: key.maxCostUsd ?? '',
            allowedModels: (key.allowedModels || []).join(', '),
          }
        : BLANK
    );
    setAction({ kind, key });
  };

  const limitsBody = () => ({
    maxPromptTokens: numberOrNull(form.maxPromptTokens),
    maxCompletionTokens: numberOrNull(form.maxCompletionTokens),
    maxCostUsd: numberOrNull(form.maxCostUsd),
    allowedModels: parseModels(form.allowedModels),
  });

  const run = async () => {
    if (!action) return;
    if (created) {
      close();
      return;
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
        body: limitsBody(),
      });
    } else if (action.kind === 'activate' || action.kind === 'deactivate') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PUT',
        body: { isActive: action.kind === 'activate' },
      });
    } else if (action.kind === 'revoke') {
      res = await call(`/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
    } else {
      const q = picked.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      res = await call(`/api/keys?${q}`, { method: 'DELETE' });
    }
    if (epoch !== actionEpoch.current) return;
    setBusy(false);
    if (!res.ok) {
      setRefused(refusal(res.status, res.body));
      return;
    }
    keys.refresh();
    if (action.kind === 'create' || action.kind === 'reveal') {
      setCreated(res.body);
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
      changes: 'Sends this credential to your browser for client setup. Its activation, expiry and limits stay as configured.',
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
    deactivate: {
      title: 'Deactivate this key',
      verb: 'Deactivate',
      requires: 'An operator session.',
      changes:
        'Stops this key authenticating on its next use. Its value and its usage record are kept.',
      undo: 'Activate it again.',
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

      <div className="measures tiles">
        <Measure
          big
          label="Keys issued"
          measure={keys.data ? { value: rows.length } : null}
          render={fmtNum}
        />
        <Measure
          big
          label="Active"
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
            keys.data
              ? { value: rows.reduce((n, k) => n + ((k.usage || {}).requests || 0), 0) }
              : null
          }
          render={fmtNum}
        />
      </div>

      <section aria-labelledby="h-keys">
        <div className="screen-head">
          <h2 id="h-keys">Client keys</h2>
          <button type="button" className="button" onClick={() => open('create')}>
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
                const hit = exceeded(k);
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
                        <span className="name" data-i18n-skip>
                          {k.name}
                        </span>
                      </label>
                      <span className="sub">
                        <span className="id" data-i18n-skip>
                          {k.id}
                        </span>
                        {k.keyPreview ? <span className="id" data-i18n-skip> {k.keyPreview}</span> : null}
                        {k.createdAt ? (
                          <>
                            {' '}
                            <span>Created</span>{' '}
                            <span data-i18n-skip>{fmtRelative(k.createdAt, now)}</span>
                          </>
                        ) : null}
                        {k.expiresAt ? (
                          <>
                            {' '}
                            <span>Expires</span>{' '}
                            <span data-i18n-skip>{fmtRelative(k.expiresAt, now)}</span>
                          </>
                        ) : (
                          <>
                            {' '}
                            <span>Never expires</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span data-i18n-skip>{fmtNum(k.deviceCount || 0)}</span>
                    <span className="status" data-tone={STATE_TONE[st]}>
                      {STATE_WORD[st]}
                    </span>
                    <details className="keys-detail">
                      <summary>Details</summary>
                      {hit ? (
                        <Notice
                          tone="bad"
                          title="This key is over one of its own ceilings."
                          next="It stops authenticating on its next use. Raise the ceiling or clear it to let the key run again."
                        />
                      ) : null}
                      <div className="keys-ceilings">
                        {CEILINGS.map((c) => (
                          <Ceiling
                            key={c.field}
                            ceiling={c}
                            limit={k[c.field]}
                            used={(k.usage || {})[c.used] || 0}
                          />
                        ))}
                      </div>
                      <dl className="facts">
                        <dt>Requests</dt>
                        <dd data-i18n-skip>{fmtNum((k.usage || {}).requests || 0)}</dd>
                        <dt>Machine</dt>
                        <dd className="id" data-i18n-skip>
                          {k.machineId}
                        </dd>
                        <dt>Models</dt>
                        <dd>
                          {k.allowedModels?.length ? (
                            <span className="id" data-i18n-skip>
                              {k.allowedModels.join(', ')}
                            </span>
                          ) : (
                            <span>Every model</span>
                          )}
                        </dd>
                      </dl>
                      <div className="verb-row">
                        <button type="button" className="button quiet" onClick={() => open('reveal', k)}>
                          <Icon name="i-keys" />
                          Reveal key
                        </button>
                        <button
                          type="button"
                          className="button quiet"
                          onClick={() => open('limits', k)}
                        >
                          <Icon name="i-edit" />
                          Edit limits
                        </button>
                        <button
                          type="button"
                          className="button quiet"
                          onClick={() => open(k.isActive ? 'deactivate' : 'activate', k)}
                        >
                          <Icon name={k.isActive ? 'i-pause' : 'i-play'} />
                          {k.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          onClick={() => open('revoke', k)}
                        >
                          <Icon name="i-delete" />
                          Revoke
                        </button>
                      </div>
                    </details>
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
                  <span>Window</span> <span data-i18n-skip>{fmtUnit(windowMinutes, 'minute')}</span>
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
                  <span data-i18n-skip>{fmtNum(picked.length)}</span> <span>selected</span>
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-who">
        <h2 id="h-who">Who may do what</h2>
        <details className="fold">
          <summary>How the two classes of caller are told apart</summary>
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
                      <span data-i18n-skip>{auth.displayName}</span>
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
        </details>
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
        <h2 id="h-keys-gap">Not reported</h2>
        <ul className="bullets">
          <li>
            Whether one named model is permitted for one key. The allowlist is shown above, but no
            route answers that question, so the gateway settles it at request time and this screen
            cannot preview the answer.
          </li>
          <li>
            A key&apos;s name and its expiry after it exists. Both are set when the key is created,
            and the update route accepts neither.
          </li>
        </ul>
      </section>

      <p className="caption">Key lists contain masked previews. Revealing a stored credential requires an explicit operator action on that key, even when dashboard sign-in is turned off.</p>

      <Confirm
        open={!!action}
        busy={busy}
        refusal={refused}
        title={created ? (action?.kind === 'reveal' ? 'Key revealed' : 'Key created') : copyFor?.title}
        verb={created ? 'Done' : copyFor?.verb}
        requires={created ? 'An operator session.' : copyFor?.requires}
        changes={created ? 'This credential is visible temporarily. Its configured activation, expiry and limits govern subsequent requests.' : copyFor?.changes}
        undo={created ? 'Close the dialog to clear the displayed value. Copied values remain on your clipboard.' : copyFor?.undo}
        irreversible={!created && !!copyFor?.irreversible}
        onConfirm={run}
        onClose={close}
      >
        {action?.kind === 'create' && !created ? (
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
        {created ? (
          <div className="keys-once">
            <p>This value clears after 60 seconds, when you leave this tab, or when you close the dialog. Use Reveal key to retrieve it again.</p>
            <code className="keys-secret" data-i18n-skip>
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
