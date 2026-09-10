'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Button, Loader, PasswordInput, TextInput, Tooltip } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtUnit } from '@/shared/format';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import board from '@/shared/workspace/board.module.css';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './access.module.css';

const METHOD = { Password: 'Password sign-in', SAML: 'SAML sign-in', OIDC: 'OIDC sign-in' };
const EMPTY_PASSWORD = { current: '', next: '', repeat: '' };
const EMPTY_OIDC = {
  oidcIssuerUrl: '',
  oidcClientId: '',
  oidcClientSecret: '',
  oidcScopes: '',
  oidcLoginLabel: '',
};
const EMPTY_SAML = {
  samlEntryPoint: '',
  samlIssuer: '',
  samlCert: '',
  samlLoginLabel: '',
  samlAttributeName: '',
  samlAttributeEmail: '',
};
const SSO_LABELS = {
  oidcIssuerUrl: 'Provider address',
  oidcClientId: 'Client identity',
  oidcClientSecret: 'Client secret',
  oidcScopes: 'Requested scopes',
  oidcLoginLabel: 'Sign-in label',
  samlEntryPoint: 'Provider address',
  samlIssuer: 'Gateway identity',
  samlCert: 'Signing certificate',
  samlLoginLabel: 'Sign-in label',
  samlAttributeName: 'Display-name attribute',
  samlAttributeEmail: 'Email attribute',
};
const PROTECTED = [
  'Shutting the gateway down.',
  'Exporting or importing the whole database.',
  'Installing an update, and the shutdown that comes with it.',
  'Every change under the operator interface, which also has to come from the machine that runs the gateway.',
];

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// A password change answers 401 only because the current password was wrong;
// the session that carried the request was valid or the guard would have
// refused it earlier. Say that instead of "your session has ended".
function passwordRefusal(status, body) {
  if (status === 401)
    return {
      tone: 'warn',
      title: 'That is not the current password.',
      next: 'Type the password this gateway uses now, then try again.',
    };
  return refusal(status, body);
}

function Unreported({ why }) {
  return (
    <>
      <span className="unreported">Not reported</span>
      <details className={styles.why}>
        <summary>Why</summary>
        <p>{why}</p>
      </details>
    </>
  );
}

// Label on the left, the value on the right, on the card's evidence grid.
function FactLine({ label, value }) {
  return (
    <div className={styles.factLine}>
      <span title={label}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function AccessPage() {
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const auth = usePoll('/api/auth/status', 15000);
  const settings = usePoll('/api/settings', 30000);
  const [open, setOpen] = useState(null);
  const [ask, setAsk] = useState(null);
  const [review, setReview] = useState(null);
  const [verifiedSettings, setVerifiedSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const [pw, setPw] = useState(EMPTY_PASSWORD);
  const [oidcDraft, setOidc] = useState(null);
  const [samlDraft, setSaml] = useState(null);
  const [probe, setProbe] = useState(null);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);

  const a = auth.data;
  const s = verifiedSettings?.source === settings.data ? verifiedSettings.data : settings.data;
  const oidc =
    oidcDraft ??
    Object.fromEntries(
      Object.keys(EMPTY_OIDC).map((key) => [key, key === 'oidcClientSecret' ? '' : s?.[key] || ''])
    );
  const saml =
    samlDraft ??
    Object.fromEntries(
      Object.keys(EMPTY_SAML).map((key) => [key, key === 'samlCert' ? '' : s?.[key] || ''])
    );
  const federated = a?.authMode === 'sso' || a?.authMode === 'oidc' || a?.authMode === 'saml';
  const protocol = federated ? a?.ssoType || 'oidc' : 'password';
  const requireLogin = a ? a.requireLogin : null;

  // Every secret this screen holds is write-only, so the fields empty the moment
  // a submit is answered, refused or not. Nothing typed here survives the reply.
  const forget = () => {
    setReview(null);
    setPw(EMPTY_PASSWORD);
    setOidc((current) => (current ? { ...current, oidcClientSecret: '' } : null));
    setSaml((current) => (current ? { ...current, samlCert: '' } : null));
  };
  useEffect(() => {
    const clear = () => {
      if (document.hidden) {
        setReview(null);
        setPw(EMPTY_PASSWORD);
        setOidc((current) => (current ? { ...current, oidcClientSecret: '' } : null));
        setSaml((current) => (current ? { ...current, samlCert: '' } : null));
      }
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);
  const cancel = () => {
    setAsk(null);
    setFailure(null);
    setBusy(false);
    forget();
  };
  const askFor = (value) => {
    setFailure(null);
    setDone(null);
    setAsk(value);
  };

  const run = async (url, body, method_, after) => {
    setBusy(true);
    setFailure(null);
    const res = await call(url, { method: method_ || 'PATCH', body });
    setBusy(false);
    forget();
    if (!res.ok) {
      setFailure(body.newPassword ? passwordRefusal(res.status, res.body) : refusal(res.status, res.body));
      return;
    }
    if (url === '/api/settings' && !body.newPassword) {
      setBusy(true);
      const readback = await call('/api/settings');
      const comparable = Object.entries(body).filter(([key]) => key !== 'oidcClientSecret');
      if (!readback.ok || !comparable.every(([key, value]) => readback.body?.[key] === value)) {
        setFailure({
          tone: 'warn',
          title: 'The setting was accepted; refreshed state was not verified.',
          next: 'Close and refresh before making another change. Do not repeat the mutation.',
        });
        return;
      }
      setVerifiedSettings({ data: readback.body, source: settings.data });
      if (Object.keys(body).some((key) => key.startsWith('oidc'))) setOidc(null);
      if (Object.keys(body).some((key) => key.startsWith('saml'))) setSaml(null);
      setBusy(false);
    }
    setAsk(null);
    setDone(after);
    auth.refresh();
    settings.refresh();
  };

  const test = async (which) => {
    setBusy(true);
    setProbe(null);
    const res = await call(which === 'saml' ? '/api/auth/saml/test' : '/api/auth/oidc/test', {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (!res.ok || res.body?.ok !== true) {
      setProbe(refusal(res.status, res.body || { error: 'The check returned no configuration verdict.' }));
    } else if (which === 'saml') {
      setProbe({
        tone: res.body.certValid === true ? 'ok' : 'warn',
        title:
          res.body.certValid === true
            ? 'Local SAML format checks passed.'
            : 'The local SAML format check was not verified.',
        next: 'The identity provider was not contacted. Sign-in was not tested.',
        detail: res.body.message,
      });
    } else if (res.body.discoveryOk !== true) {
      setProbe({ tone: 'warn', title: 'Provider discovery was not verified.', detail: res.body.message });
    } else if (res.body.clientSecretTested === true && res.body.clientSecretValid === false) {
      setProbe({
        tone: 'bad',
        title: 'The provider rejected the client credentials.',
        detail: res.body.error || res.body.message,
      });
    } else if (res.body.clientSecretTested === true && res.body.clientSecretValid === true) {
      setProbe({
        tone: 'ok',
        title: 'Provider discovery and the client credential check passed.',
        next: 'Sign-in and redirect completion were not tested.',
        detail: res.body.message,
      });
    } else {
      setProbe({
        tone: 'warn',
        title: 'Provider discovery loaded; client credentials were not verified.',
        next: 'Sign-in and redirect completion were not tested.',
        detail: res.body.message,
      });
    }
  };

  const mismatch = pw.next !== '' && pw.repeat !== '' && pw.next !== pw.repeat;
  const passwordReady = Boolean(a) && Boolean(pw.next) && pw.next === pw.repeat && (!a.hasPassword || Boolean(pw.current));

  const askMethod = (id) =>
    askFor({
      key: `method:${id}`,
      title: 'Change the sign-in method',
      verb: 'Change method',
      requires: 'A session, and a provider that is already configured if you are moving to one.',
      changes:
        'The sign-in screen offers the method you chose. Password sign-in is refused only once the chosen provider is fully configured, so an unfinished provider still leaves the password working.',
      undo: 'Change it back here.',
      onConfirm: () =>
        run(
          '/api/settings',
          id === 'password' ? { authMode: 'password' } : { authMode: 'sso', ssoType: id },
          'PATCH',
          'Sign-in method changed.'
        ),
    });

  const askClear = (id) =>
    askFor({
      key: `clear:${id}`,
      title: 'Clear the configuration',
      verb: 'Clear the configuration',
      requires: 'A session.',
      changes:
        'The provider address and identity are removed, so the gateway no longer offers this sign-in. A stored client secret is not removed by this, because the gateway refuses to store an empty one.',
      undo: 'Type the values again here. The provider itself is untouched.',
      onConfirm: () =>
        run(
          '/api/settings',
          id === 'saml' ? { samlEntryPoint: '', samlCert: '' } : { oidcIssuerUrl: '', oidcClientId: '' },
          'PATCH',
          'Single sign-on cleared.'
        ),
    });

  const askReview = (id) => {
    const body =
      id === 'saml'
        ? Object.fromEntries(Object.entries(saml).filter(([key, value]) => key !== 'samlCert' || value.trim()))
        : { ...oidc };
    setReview({ kind: 'sso', protocol: id, body });
    askFor({
      key: `sso:${id}`,
      reviewKind: 'sso',
      title: 'Configure single sign-on',
      verb: 'Save configuration',
      requires: 'A session, and the values the identity provider issued for this gateway.',
      changes:
        'Stores the identity-provider configuration for subsequent sign-ins. Empty secret and certificate fields preserve stored values. This does not test sign-in completion.',
      undo: 'Clear the configuration here, or type new values over it.',
      body: (
        <dl className={styles.review}>
          <div>
            <dt>Protocol</dt>
            <dd>{id.toUpperCase()}</dd>
          </div>
          {Object.entries(body).map(([key, value]) => (
            <div key={key} className={styles.reviewEntry}>
              <dt>{SSO_LABELS[key]}</dt>
              <dd>
                {key === 'oidcClientSecret' || key === 'samlCert'
                  ? value
                    ? 'Replacement supplied, value hidden'
                    : 'Preserve stored value'
                  : value || 'Empty'}
              </dd>
            </div>
          ))}
        </dl>
      ),
      onConfirm: () =>
        run(
          '/api/settings',
          body,
          'PATCH',
          'Single sign-on configuration saved and read back. Sign-in has not been tested.'
        ),
    });
  };

  const methods = [
    {
      id: 'password',
      name: 'Password',
      purpose: 'One stored password, no outside provider',
      configured: Boolean(a?.hasPassword) || a?.passwordSource === 'environment',
    },
    {
      id: 'oidc',
      name: 'OIDC',
      purpose: 'An OpenID Connect identity provider',
      configured: Boolean(a?.oidcConfigured),
    },
    {
      id: 'saml',
      name: 'SAML',
      purpose: 'A SAML 2.0 identity provider',
      configured: Boolean(a?.samlConfigured),
    },
  ].map((method) => ({
    ...method,
    bucket: method.id === protocol ? 'force' : method.configured ? 'ready' : 'absent',
  }));
  const counts = {
    force: methods.filter((m) => m.bucket === 'force').length,
    ready: methods.filter((m) => m.bucket === 'ready').length,
    absent: methods.filter((m) => m.bucket === 'absent').length,
  };
  const chips = [
    { id: null, label: 'methods', count: methods.length },
    { id: 'force', tone: 'positive', label: 'in force', count: counts.force },
    { id: 'ready', label: 'ready', count: counts.ready },
    { id: 'absent', tone: 'ember', label: 'not configured', count: counts.absent },
  ];
  const visible = methods.filter(
    (method) =>
      (!bucket || method.bucket === bucket) &&
      (!query.trim() || `${method.name} ${method.purpose}`.toLowerCase().includes(query.trim().toLowerCase()))
  );
  const word = { force: 'In force', ready: 'Ready', absent: 'Not configured' };
  const tone = { force: 'positive', ready: null, absent: 'ember' };

  const ssoFields = (id) => {
    const draft = id === 'saml' ? saml : oidc;
    const set = id === 'saml' ? setSaml : setOidc;
    const fields =
      id === 'saml'
        ? [
            ['samlEntryPoint', 'Provider address', 'url'],
            ['samlIssuer', 'Our identity to the provider', 'text'],
            ['samlAttributeName', 'Display-name attribute', 'text'],
            ['samlAttributeEmail', 'Email attribute', 'text'],
            ['samlCert', 'Signing certificate', 'password'],
            ['samlLoginLabel', 'Label on the sign-in action', 'text'],
          ]
        : [
            ['oidcIssuerUrl', 'Provider address', 'url'],
            ['oidcClientId', 'Client identity', 'text'],
            ['oidcClientSecret', 'Client secret', 'password'],
            ['oidcScopes', 'Requested scopes', 'text'],
            ['oidcLoginLabel', 'Label on the sign-in action', 'text'],
          ];
    return (
      <div className={styles.fields}>
        {fields.map(([key, label, type]) =>
          type === 'password' ? (
            <PasswordInput
              key={key}
              size="xs"
              label={label}
              autoComplete="new-password"
              value={draft[key]}
              onChange={(event) => set({ ...draft, [key]: event.currentTarget.value })}
            />
          ) : (
            <TextInput
              key={key}
              size="xs"
              type={type}
              label={label}
              value={draft[key]}
              onChange={(event) => set({ ...draft, [key]: event.currentTarget.value })}
            />
          )
        )}
      </div>
    );
  };

  const methodDetail = (method) => {
    if (method.id === 'password')
      return (
        <div className={styles.detail}>
          <p className={styles.aside}>A stored password is never readable back, here or anywhere else.</p>
          <div className={styles.fields}>
            {a?.hasPassword ? (
              <PasswordInput
                size="xs"
                label="Current password"
                autoComplete="current-password"
                value={pw.current}
                onChange={(event) => setPw({ ...pw, current: event.currentTarget.value })}
              />
            ) : null}
            <PasswordInput
              size="xs"
              label="New password"
              autoComplete="new-password"
              value={pw.next}
              onChange={(event) => setPw({ ...pw, next: event.currentTarget.value })}
            />
            <PasswordInput
              size="xs"
              label="New password again"
              autoComplete="new-password"
              value={pw.repeat}
              onChange={(event) => setPw({ ...pw, repeat: event.currentTarget.value })}
            />
          </div>
          {mismatch ? (
            <p className={styles.deny} role="alert">
              <strong>The two new passwords are not the same.</strong> Type the same password twice, so a
              typo cannot lock you out.
            </p>
          ) : null}
          <span className={styles.actions}>
            <Button
              size="xs"
              disabled={busy || !passwordReady}
              onClick={() => {
                setReview({ kind: 'password', body: { currentPassword: pw.current, newPassword: pw.next } });
                askFor({
                  key: 'password',
                  reviewKind: 'password',
                  title: 'Change password',
                  verb: 'Change password',
                  requires: a?.hasPassword
                    ? 'The password this gateway uses now.'
                    : 'Nothing. No password is stored yet.',
                  changes:
                    'Every sign-in after this one uses the new password. Sessions already issued keep working until they expire.',
                  undo: 'The old password cannot be recovered.',
                  irreversible: true,
                  onConfirm: () =>
                    run(
                      '/api/settings',
                      { currentPassword: pw.current, newPassword: pw.next },
                      'PATCH',
                      'Password changed.'
                    ),
                });
              }}
            >
              Change password
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() =>
                askFor({
                  key: 'reset',
                  title: 'Clear stored password',
                  verb: 'Clear stored password',
                  requires: 'A request from the machine that runs the gateway, or the command-line token.',
                  changes:
                    'The stored password is cleared. The next sign-in uses the process startup password, or the built-in default when none is configured. Remote sign-in is refused only for the built-in default.',
                  undo: 'The old password cannot be recovered.',
                  irreversible: true,
                  onConfirm: () =>
                    run(
                      '/api/auth/reset-password',
                      {},
                      'POST',
                      'Stored password cleared. Sign-in now uses the process startup password.'
                    ),
                })
              }
            >
              Clear stored password
            </Button>
          </span>
        </div>
      );
    return (
      <div className={styles.detail}>
        {ssoFields(method.id)}
        <p className={styles.aside}>
          Empty secret or certificate fields preserve stored values. Review before applying; a saved
          configuration does not establish a successful sign-in.
        </p>
        <span className={styles.actions}>
          <Button size="xs" disabled={busy || !s} onClick={() => askReview(method.id)}>
            Review configuration
          </Button>
          <Button size="xs" variant="default" disabled={busy} onClick={() => test(method.id)}>
            Test without saving
          </Button>
          <Button size="xs" variant="default" onClick={() => askClear(method.id)}>
            Clear the configuration
          </Button>
        </span>
        {probe ? (
          <p className={`${styles.probe} notice`} data-tone={probe.tone} role="status">
            <strong>{probe.title}</strong> {probe.next} {probe.detail}
          </p>
        ) : null}
        <p className={styles.aside}>
          {method.id === 'saml'
            ? 'This checks the stored SAML format locally. It does not contact the identity provider or complete sign-in.'
            : 'This reads provider discovery and checks stored client credentials when available. It does not complete sign-in.'}{' '}
          Nothing is saved. A stored client secret cannot be cleared from here, only replaced.
        </p>
      </div>
    );
  };

  const methodEvidence = (method) => {
    if (method.id === 'password')
      return (
        <>
          <FactLine
            label="Stored password"
            value={
              a ? (
                <span className="status" data-tone={a.hasPassword ? 'ok' : 'warn'}>
                  {a.hasPassword ? 'Set' : 'Not set'}
                </span>
              ) : (
                <span className="skeleton">Reading</span>
              )
            }
          />
          <FactLine
            label="Password source"
            value={
              a?.passwordSource === 'stored'
                ? 'Stored password'
                : a?.passwordSource === 'environment'
                  ? 'Process configuration'
                  : a?.passwordSource === 'default'
                    ? 'Built-in default'
                    : 'Not reported'
            }
          />
        </>
      );
    if (method.id === 'oidc')
      return (
        <>
          <FactLine label="Provider address" value={s?.oidcIssuerUrl || 'Not configured'} />
          <FactLine label="Client identity" value={s?.oidcClientId || 'Not configured'} />
          <FactLine
            label="Client secret"
            value={
              <span className="status" data-tone={a?.oidcConfigured ? 'ok' : 'warn'}>
                {a?.oidcConfigured ? 'Set' : 'Not set'}
              </span>
            }
          />
          <FactLine label="Requested scopes" value={s?.oidcScopes || 'Not configured'} />
          <FactLine label="Sign-in label" value={a?.oidcLoginLabel || 'Not reported'} />
        </>
      );
    return (
      <>
        <FactLine label="Provider address" value={s?.samlEntryPoint || 'Not configured'} />
        <FactLine label="Gateway identity" value={s?.samlIssuer || 'Not configured'} />
        <FactLine
          label="Signing certificate"
          value={
            <span className="status" data-tone={a?.samlConfigured ? 'ok' : 'warn'}>
              {a?.samlConfigured ? 'Set' : 'Not set'}
            </span>
          }
        />
        <FactLine
          label="Asserted name and address"
          value={s ? `${s.samlAttributeName} · ${s.samlAttributeEmail}` : 'Reading'}
        />
        <FactLine label="Sign-in label" value={a?.samlLoginLabel || 'Not reported'} />
        <FactLine
          label="Metadata"
          value={<a href="/api/auth/saml/metadata">Open the published document</a>}
        />
      </>
    );
  };

  const askStrip = (key) =>
    ask?.key === key ? (
      <InlineConfirm
        {...ask}
        busy={busy}
        refusal={failure}
        disabled={Boolean(ask.reviewKind) && review?.kind !== ask.reviewKind}
        onConfirm={ask.onConfirm}
        onCancel={cancel}
      />
    ) : null;

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Access</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · who may sign in, how, and what stays protected</p>
        </div>
        <Freshness status={pollFresh(auth)} lastDataAt={auth.goodAt} />
      </div>

      <div className={`${shared.lensBody} ${styles.stack}`}>
        {done ? (
          <p className={styles.pageNotice} role="status" data-tone="ok">
            {done}
          </p>
        ) : null}
        {auth.error ? (
          <p className={styles.pageNotice} role="status" data-tone="warn">
            {refusal(auth.status, auth.error).title} {refusal(auth.status, auth.error).next}{' '}
            <button type="button" className={board.linkButton} onClick={auth.refresh}>
              Retry sign-in status
            </button>
          </p>
        ) : null}
        {settings.error && !s ? (
          <p className={styles.pageNotice} role="status" data-tone="warn">
            {refusal(settings.status, settings.error).title} {refusal(settings.status, settings.error).next}
          </p>
        ) : null}
        {a?.passwordSource === 'default' ? (
          <p className={styles.pageNotice} role="alert" data-tone="bad">
            <strong>This installation is still on its default password.</strong> Change it in the Password
            card. Until it changes, a correct sign-in from anywhere but this machine is refused, because the
            default is public knowledge.
          </p>
        ) : null}

        <Board label="Access" advanced={advanced} density={density}>
          <BoardSummary
            label="Sign-in summary"
            chips={chips}
            active={bucket}
            onPick={(id) => setBucket(id === bucket ? null : id)}
            note={
              auth.loading && !a
                ? 'Reading sign-in status…'
                : `Signing in ${requireLogin ? 'required' : 'not required'} · ${METHOD[federated ? (protocol === 'saml' ? 'SAML' : 'OIDC') : 'Password']}`
            }
          />
          <BoardToolbar
            search={query}
            onSearch={setQuery}
            searchLabel="Search sign-in methods"
            actions={
              <>
                <Button
                  size="xs"
                  leftSection={<Icon name="i-keys" />}
                  aria-expanded={open === 'password'}
                  onClick={() => setOpen((current) => (current === 'password' ? null : 'password'))}
                >
                  Change password
                </Button>
                <Tooltip label="Re-read sign-in status and settings">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh access"
                    loading={auth.loading || settings.loading}
                    onClick={() => {
                      auth.refresh();
                      settings.refresh();
                    }}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          >
            <Tooltip label="How much room each card takes">
              <DensitySwitch value={density} onChange={setDensity} />
            </Tooltip>
          </BoardToolbar>

          {visible.length ? (
            <BoardGroup label="Sign-in methods" count={visible.length}>
              {visible.map((method) => (
                <Card
                  key={method.id}
                  id={method.id}
                  bucket={method.bucket === 'absent' ? 'low' : undefined}
                  expanded={open === method.id}
                  label={`${method.name} sign-in`}
                  detail={open === method.id ? methodDetail(method) : null}
                  head={
                    <>
                      <span className={styles.mark} aria-hidden="true">
                        <Icon name={method.id === 'password' ? 'i-keys' : 'i-connections'} />
                      </span>
                      <div className={board.identityText}>
                        <strong>{method.name}</strong>
                        <small>{method.purpose}</small>
                      </div>
                      <Tooltip label={open === method.id ? 'Collapse' : 'Settings and evidence'}>
                        <button
                          type="button"
                          className={board.caret}
                          aria-expanded={open === method.id}
                          aria-label={`${open === method.id ? 'Collapse' : 'Expand'} ${method.name}`}
                          onClick={() => setOpen((current) => (current === method.id ? null : method.id))}
                        >
                          <Icon name={open === method.id ? 'i-chevron-up' : 'i-chevron-down'} />
                        </button>
                      </Tooltip>
                    </>
                  }
                  state={
                    <>
                      <StateWord tone={tone[method.bucket]}>{word[method.bucket]}</StateWord>
                      <span className={board.spacer} />
                      {method.bucket !== 'force' ? (
                        <Button size="compact-xs" variant="default" onClick={() => askMethod(method.id)}>
                          Use this method
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  {methodEvidence(method)}
                  {askStrip(`method:${method.id}`)}
                  {askStrip(`sso:${method.id}`)}
                  {askStrip(`clear:${method.id}`)}
                  {method.id === 'password' ? askStrip('password') : null}
                  {method.id === 'password' ? askStrip('reset') : null}
                </Card>
              ))}
            </BoardGroup>
          ) : null}

          <BoardGroup label="Session" count={2}>
            <Card
              id="session"
              label="Your session"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-access" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Your session</strong>
                    <small>{a?.authenticated ? a.displayName : 'Not signed in'}</small>
                  </div>
                </>
              }
              state={
                <>
                  <StateWord tone={a?.authenticated ? 'positive' : 'ember'}>
                    {a?.authenticated ? 'Signed in' : 'Not signed in'}
                  </StateWord>
                  <span className={board.spacer} />
                  <span className={board.cardAttempts}>
                    {a?.authenticated ? METHOD[a.loginMethod] || a.loginMethod : ''}
                  </span>
                </>
              }
            >
              <FactLine label="Lifetime" value="24 hours from issue" />
              <FactLine
                label="Issued and expires"
                value={
                  <Unreported why="The session lives in a cookie the browser will not hand to a script, and no route reports when it was issued." />
                }
              />
              <p className={styles.aside}>A session is not extended by use.</p>
            </Card>
            <Card
              id="lockout"
              label="Lockout rules"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-clock" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Lockout rules</strong>
                    <small>Five wrong passwords from one address lock that address out</small>
                  </div>
                </>
              }
            >
              <FactLine label="First lockout" value={fmtUnit(30, 'second')} />
              <FactLine label="Second" value={fmtUnit(2, 'minute')} />
              <FactLine label="Third" value={fmtUnit(10, 'minute')} />
              <FactLine label="Fourth and after" value={fmtUnit(30, 'minute')} />
              <FactLine label="Failures forgotten after" value={fmtUnit(1, 'hour')} />
              <FactLine
                label="Attempts left"
                value={
                  <Unreported why="Only the sign-in screen is told, and only the address that is failing. No route reports the counter to an operator." />
                }
              />
              <p className={styles.aside}>
                A failed single sign-on counts against the same five. The counter lives in memory, so
                restarting the gateway clears every lockout.
              </p>
            </Card>
          </BoardGroup>

          <BoardGroup label="Protection" count={2}>
            <Card
              id="require-login"
              bucket={requireLogin === false ? 'attention' : undefined}
              label="Signing in"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-access" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Signing in</strong>
                    <small>The widest decision on this screen</small>
                  </div>
                </>
              }
              state={
                <>
                  <StateWord tone={requireLogin ? 'positive' : 'refusal'}>
                    {requireLogin === null ? 'Reading' : requireLogin ? 'Required' : 'Not required'}
                  </StateWord>
                  <span className={board.spacer} />
                  {a ? (
                    <Button
                      size="compact-xs"
                      variant={requireLogin ? 'default' : 'filled'}
                      color={requireLogin ? 'red' : undefined}
                      onClick={() =>
                        askFor(
                          requireLogin
                            ? {
                                key: 'off',
                                title: 'Turn sign-in off',
                                verb: 'Turn sign-in off',
                                requires: 'A session, which you have.',
                                changes:
                                  'Anyone who can reach this port reads the dashboard and changes most settings without a password. Shutdown, database export and import, and update still ask for a session, and every change under the operator interface stays bound to this machine.',
                                undo: 'Turn it back on here. While it is off, anyone who reaches the port can turn it on or off too.',
                                onConfirm: () =>
                                  run('/api/settings', { requireLogin: false }, 'PATCH', 'Sign-in turned off.'),
                              }
                            : {
                                key: 'on',
                                title: 'Turn sign-in on',
                                verb: 'Turn sign-in on',
                                requires:
                                  'Nothing. Sign-in is off, so this screen is open to anyone who reached the port.',
                                changes:
                                  'Every dashboard route asks for a session again. Sign in with the password above.',
                                undo: 'Turn it back off here, once signed in.',
                                onConfirm: () =>
                                  run('/api/settings', { requireLogin: true }, 'PATCH', 'Sign-in turned on.'),
                              }
                        )
                      }
                    >
                      {requireLogin ? 'Turn sign-in off' : 'Turn sign-in on'}
                    </Button>
                  ) : null}
                </>
              }
            >
              <p className={styles.aside}>
                Four things keep asking for a session either way, and they are the ones that end or replace
                the installation.
              </p>
              <ul className={styles.bullets}>
                {PROTECTED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className={styles.aside}>
                A rejected request changes nothing. State reads exactly as it did the moment before the
                attempt.
              </p>
              {askStrip('off')}
              {askStrip('on')}
            </Card>
            <Card
              id="api-keys"
              label="Client keys for inference"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-keys" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Client keys for inference</strong>
                    <small>A caller holding only one is told it holds the wrong kind of credential</small>
                  </div>
                </>
              }
              state={
                <>
                  <StateWord tone={s?.requireApiKey ? 'positive' : 'ember'}>
                    {s ? (s.requireApiKey ? 'Required' : 'Not required') : 'Reading'}
                  </StateWord>
                  <span className={board.spacer} />
                  <Link href="/dashboard/keys" prefetch={false}>
                    Keys
                  </Link>
                </>
              }
            >
              <p className={styles.aside}>An inference key never reaches anything on this screen.</p>
            </Card>
          </BoardGroup>

          <div className={board.messages}>
            {auth.loading && !a ? (
              <div className={board.empty}>
                <Loader size="xs" /> Reading sign-in status…
              </div>
            ) : null}
            {a && !visible.length ? (
              <div className={board.empty}>
                No sign-in method matches.{' '}
                <button
                  type="button"
                  className={board.linkButton}
                  onClick={() => {
                    setQuery('');
                    setBucket(null);
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>
        </Board>
      </div>
    </div>
  );
}
