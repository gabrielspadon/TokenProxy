'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Button, FileInput, Loader, PasswordInput, Tooltip } from '@mantine/core';
import AdmissionControls from './AdmissionControls';
import { usePoll } from '@/shared/hooks/usePoll';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { refusal } from '@/shared/refusal';
import { fmtDuration, fmtTime, fmtUnit } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';
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
import { FactLine } from './SettingRow';
import styles from './system.module.css';
import './styles.css';

const STATE_TONE = { ok: 'positive', warn: 'ember', bad: 'refusal' };
const BACKUP_HOLDS =
  'Writes a configuration file with readable connection credentials and client keys. Retained usage, operations, investigations, rules, compatibility and routing-version history are excluded. The gateway is unchanged.';

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// The null contract outside .measures: never a zero, always the reason.
function Unreported({ why }) {
  return (
    <>
      <span className="unreported">Not reported</span>
      <details className="why">
        <summary>Why</summary>
        <p>{why}</p>
      </details>
    </>
  );
}

// The password routes answer 401 with "Invalid password", which is a different
// sentence from a session that ended. `message` is what the version routes
// carry instead of `error`, so their refusal keeps its own words.
function systemRefusal(status, body, password = false) {
  if (password && status === 401) {
    return {
      tone: 'warn',
      title: 'That password is not right.',
      next: 'Nothing was changed. Type it again.',
    };
  }
  const r = refusal(status, body);
  return body?.message && !body.error ? { ...r, detail: body.message } : r;
}

function Notice({ tone, title, next, detail, action }) {
  return (
    <p className={`${styles.pageNotice} notice`} data-tone={tone} role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>{title}</strong> {next} {detail} {action}
    </p>
  );
}

export default function SystemPage() {
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const health = usePoll('/api/admin/health', 15000);
  const detail = usePoll('/api/admin/health/detail', 15000);
  const version = usePoll('/api/version', 0);
  const policy = usePoll('/api/settings/require-login', 0);
  const [notes, setNotes] = useState({ state: 'loading', text: '' });
  const [ask, setAsk] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState(null);
  const [done, setDone] = useState(null);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const importFileInput = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/changelog', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (alive) setNotes({ state: t.trim() ? 'ready' : 'empty', text: t });
      })
      .catch(() => {
        if (alive) setNotes({ state: 'unavailable', text: '' });
      });
    return () => {
      alive = false;
    };
  }, []);

  const v = version.data;
  const db = detail.data?.checks?.database;
  const conns = detail.data?.checks?.connections || [];
  const rollup = detail.data?.status;
  const updateState = !v ? null : v.hasUpdate ? 'available' : v.latestVersion ? 'current' : 'unknown';

  const cancel = () => {
    setAsk(null);
    setRefuse(null);
    setBusy(false);
    setPassword('');
  };
  // `ask` is only the key of the act being confirmed. Its sentence, its body
  // and the call it makes are read from ACTS on the current render, so a
  // password typed inside the confirmation is the one that gets sent.
  const askFor = (key) => {
    setRefuse(null);
    setDone(null);
    setAsk(key);
  };
  const finish = (at, title, next) => {
    setAsk(null);
    setFile(null);
    setPassword('');
    if (importFileInput.current) importFileInput.current.value = '';
    setDone({ at, tone: 'ok', title, next });
  };

  const doExport = async () => {
    setBusy(true);
    setRefuse(null);
    try {
      const res = await fetch('/api/settings/database', {
        cache: 'no-store',
        headers: { 'x-tp-password': password },
      });
      if (!res.ok) {
        setRefuse(systemRefusal(res.status, await res.json().catch(() => null), true));
        return;
      }
      // The file is never rendered; it goes straight from the response to disk.
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `tokenproxy-configuration-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      finish(
        'export',
        'The backup download was requested.',
        'Confirm it in your browser downloads. It holds every credential in readable form, so keep it where you would keep a password.'
      );
    } catch (e) {
      setRefuse(systemRefusal(0, { error: e.message, code: 'network' }));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const doImport = async () => {
    setBusy(true);
    setRefuse(null);
    try {
      if (!file) {
        setRefuse({ tone: 'warn', title: 'Choose a backup file first.' });
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        setRefuse({
          tone: 'warn',
          title: 'That file is not a TokenProxy backup.',
          next: 'Choose the JSON file a backup export wrote.',
        });
        return;
      }
      const res = await fetch('/api/settings/database', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tp-password': password },
        body: JSON.stringify({ ...payload, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRefuse(systemRefusal(res.status, body, true));
        return;
      }
      if (res.status === 207 || body?.outcome === 'partial') {
        setAsk(null);
        setPassword('');
        setDone({
          at: 'import',
          tone: 'warn',
          title: 'Database imported; runtime refresh incomplete.',
          next:
            body.message ||
            'Read the restored configuration and resolve the reported runtime refresh failure. Do not automatically repeat the import.',
        });
        detail.refresh();
        policy.refresh();
        return;
      }
      finish(
        'import',
        'The database import returned successfully.',
        'Read the restored connections, keys and settings before another mutation. This response does not independently verify every imported record.'
      );
    } catch (e) {
      setRefuse(systemRefusal(0, { error: e.message, code: 'network' }));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const post = async (url, at, title, next) => {
    setBusy(true);
    setRefuse(null);
    try {
      const res = await fetch(url, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.success === false) {
        setRefuse(systemRefusal(res.status, body));
        return;
      }
      finish(at, title, next);
    } catch (e) {
      setRefuse(systemRefusal(0, { error: e.message, code: 'network' }));
    } finally {
      setBusy(false);
    }
  };

  const passwordField = (
    <PasswordInput
      size="xs"
      label="Dashboard password"
      name="password"
      autoComplete="current-password"
      required
      className={styles.password}
      value={password}
      onChange={(e) => setPassword(e.currentTarget.value)}
    />
  );

  const ACTS = {
    export: {
      title: 'Export configuration',
      verb: 'Export configuration',
      requires: 'The dashboard password.',
      changes: BACKUP_HOLDS,
      undo: 'Delete the file. The gateway itself is unchanged either way.',
      body: passwordField,
      run: doExport,
    },
    import: {
      title: 'Import configuration',
      verb: 'Import configuration',
      irreversible: true,
      requires: 'The dashboard password, and a backup file written by an export.',
      changes:
        'Replaces settings, provider connections and nodes, proxy pools, client keys, routing plans, aliases, custom models and pricing with the file contents. Usage, operation, investigation, notification-rule and compatibility history are outside this import scope.',
      undo: 'Export the current configuration first if you may need to restore it. Retained history is outside this export.',
      body: (
        <>
          <p className={styles.aside}>
            Selected file <strong>{file?.name || 'No file selected'}</strong>
          </p>
          {passwordField}
        </>
      ),
      run: doImport,
    },
    update: {
      title: 'Update now',
      verb: 'Update now',
      irreversible: true,
      requires: 'An operator credential. This holds even when sign-in is turned off.',
      changes: 'Installs the published version and stops this process. Every request in flight is cut.',
      undo: 'Install the earlier version by hand to go back.',
      body: (
        <dl className="system-facts">
          <dt>Running</dt>
          <dd className="id">{v?.currentVersion || '?'}</dd>
          <dt>Published</dt>
          <dd>
            {v?.latestVersion ? (
              <span className="id">{v.latestVersion}</span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
        </dl>
      ),
      run: () =>
        post(
          '/api/version/update',
          'update',
          'The updater started.',
          'This process exits in a moment. It comes back on its own only if something supervises it.'
        ),
    },
    shutdown: {
      title: 'Shut down',
      verb: 'Shut down',
      irreversible: true,
      requires: 'An operator credential. This holds even when sign-in is turned off.',
      changes: 'Stops the process. Every request in flight is cut, and every client is refused.',
      undo: 'Start TokenProxy again by hand on the machine that runs it.',
      run: () =>
        post(
          '/api/version/shutdown',
          'shutdown',
          'Shutting down.',
          'Every client is refused until you start TokenProxy again by hand.'
        ),
    },
  };
  const askStrip = (key) =>
    ask === key ? (
      <InlineConfirm
        {...ACTS[key]}
        submit
        busy={busy}
        refusal={refuse}
        onConfirm={ACTS[key].run}
        onCancel={cancel}
      />
    ) : null;

  const checks = [
    ...(detail.data
      ? [
          {
            id: 'database',
            name: 'Database',
            sub: db?.driver || 'Driver not reported',
            status: db?.status,
            lines: [
              db && db.latencyMs !== null && db.latencyMs !== undefined
                ? ['Latency', fmtUnit(db.latencyMs, 'millisecond')]
                : null,
              db?.error ? ['Error', db.error] : null,
            ].filter(Boolean),
          },
        ]
      : []),
    ...conns.map((c) => ({
      id: c.connectionId,
      name: c.displayName || c.provider,
      sub: c.provider,
      href: `/dashboard/connections/${c.connectionId}`,
      status: c.status,
      lines: [c.lastError ? ['Last error', c.lastError] : null, c.isDraining ? ['Draining', 'Yes'] : null].filter(
        Boolean
      ),
    })),
  ];
  const counts = checks.reduce((into, check) => {
    const tone = TONE[check.status] || 'warn';
    into[tone] = (into[tone] || 0) + 1;
    return into;
  }, {});
  const chips = [
    { id: null, label: 'checks', count: checks.length },
    { id: 'ok', tone: 'positive', label: 'healthy', count: counts.ok || 0 },
    { id: 'warn', tone: 'ember', label: 'degraded', count: counts.warn || 0 },
    { id: 'bad', tone: 'refusal', label: 'failing', count: counts.bad || 0 },
  ];
  const matches = (text) =>
    !query.trim() || String(text).toLowerCase().includes(query.trim().toLowerCase());
  const visibleChecks = checks.filter(
    (check) => (!bucket || (TONE[check.status] || 'warn') === bucket) && matches(`${check.name} ${check.sub}`)
  );

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>System</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · what this process is running, and what may replace it</p>
        </div>
        <div className={styles.headActions}>
          <Button component={Link} href="/dashboard/operations" size="xs" variant="default">
            Operation history
          </Button>
          <Freshness status={pollFresh(health)} lastDataAt={health.goodAt} />
        </div>
      </div>

      <div className={`${shared.lensBody} ${styles.stack}`}>
        {health.error ? (
          <Notice
            {...(health.data && (health.status === 0 || health.error.code === 'network')
              ? {
                  tone: 'warn',
                  title: 'Process health could not be refreshed.',
                  next: 'Showing the last successful observation. Current liveness is unknown until the next successful read.',
                }
              : refusal(health.status, health.error))}
            action={
              <button type="button" className={board.linkButton} onClick={health.refresh} disabled={health.loading}>
                Retry process health read
              </button>
            }
          />
        ) : null}
        {version.error ? (
          <Notice
            {...(version.status === 0 || version.error.code === 'network'
              ? {
                  tone: 'bad',
                  title: 'Version information could not be read.',
                  next: 'Retry this read. Process health is reported separately below.',
                }
              : systemRefusal(version.status, version.error))}
            action={
              <button type="button" className={board.linkButton} onClick={version.refresh} disabled={version.loading}>
                Retry version read
              </button>
            }
          />
        ) : null}
        {detail.error ? (
          <Notice
            {...(detail.status === 0 || detail.error.code === 'network'
              ? {
                  tone: 'warn',
                  title: 'Readiness checks could not be refreshed.',
                  next: detail.data
                    ? 'Showing the last successful checks. Current database and connection readiness remain unverified.'
                    : 'Retry these checks. Process liveness is reported separately.',
                }
              : refusal(detail.status, detail.error))}
            action={
              <button type="button" className={board.linkButton} onClick={detail.refresh} disabled={detail.loading}>
                Retry readiness read
              </button>
            }
          />
        ) : null}
        {detail.data?.scanFailed ? (
          <Notice
            tone="warn"
            title="The connection scan did not finish."
            next="The list below may be short. It runs again on the next read."
          />
        ) : null}
        {done ? <Notice tone={done.tone} title={done.title} next={done.next} /> : null}

        <Board label="System" advanced={advanced} density={density}>
          <BoardSummary
            label="System summary"
            chips={chips}
            active={bucket}
            onPick={(id) => setBucket(id === bucket ? null : id)}
            note={
              health.data
                ? `Up ${fmtDuration(health.data.uptimeSeconds * 1000)}${rollup ? ` · ${WORDS[rollup] || rollup}` : ''}${
                    db && db.latencyMs !== null && db.latencyMs !== undefined
                      ? ` · database ${fmtUnit(db.latencyMs, 'millisecond')}`
                      : ''
                  }`
                : 'Reading process health…'
            }
          />
          <BoardToolbar
            search={query}
            onSearch={setQuery}
            searchLabel="Search checks"
            actions={
              <>
                <Button
                  size="xs"
                  leftSection={<Icon name="i-copy" />}
                  onClick={() => askFor('export')}
                >
                  Export configuration
                </Button>
                <Tooltip label="Re-read process health, readiness and version">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh system reads"
                    loading={health.loading || detail.loading}
                    onClick={() => {
                      health.refresh();
                      detail.refresh();
                      version.refresh();
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
          {ask === 'export' ? <div className={board.notice}>{askStrip('export')}</div> : null}

          <BoardGroup label="Runtime" count={3}>
            <Card
              id="process"
              label="Process"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-system" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Process</strong>
                    <small>This gateway, as it is running now</small>
                  </div>
                </>
              }
              state={
                <>
                  <StateWord tone={health.data ? 'positive' : health.loading ? null : 'refusal'}>
                    {health.data ? 'Up' : health.loading ? 'Reading' : 'Not answering'}
                  </StateWord>
                  <span className={board.spacer} />
                  <span className={board.cardAttempts}>
                    {health.data ? fmtDuration(health.data.uptimeSeconds * 1000) : ''}
                  </span>
                </>
              }
            >
              <dl className="system-facts">
                <dt>Reading taken</dt>
                <dd>
                  {health.data?.generatedAt ? (
                    <span>{fmtTime(health.data.generatedAt)}</span>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                </dd>
                <dt>Tray mode</dt>
                <dd>
                  {v ? (
                    v.isTrayMode ? (
                      'On'
                    ) : (
                      'Off'
                    )
                  ) : version.loading ? (
                    <span className="skeleton">Reading</span>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                </dd>
              </dl>
            </Card>

            <Card
              id="version"
              bucket={updateState === 'available' ? 'low' : undefined}
              label="Version"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-compatibility" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Version</strong>
                    <small>What is installed, and what is published</small>
                  </div>
                </>
              }
              state={
                <>
                  <StateWord
                    tone={updateState === 'available' ? 'ember' : updateState === 'current' ? 'positive' : null}
                  >
                    {updateState === 'available'
                      ? 'Update available'
                      : updateState === 'current'
                        ? 'Up to date'
                        : version.loading
                          ? 'Reading'
                          : 'Publication not reported'}
                  </StateWord>
                  <span className={board.spacer} />
                  <span className={board.cardAttempts}>{v?.currentVersion || ''}</span>
                </>
              }
            >
              <dl className="system-facts">
                <dt>Running version</dt>
                <dd>
                  {v?.currentVersion ? (
                    <>
                      <span className="id">{v.currentVersion}</span>
                      {v.buildSha ? (
                        <>
                          {' '}
                          <span className="id">{v.buildSha}</span>
                        </>
                      ) : null}
                    </>
                  ) : version.loading ? (
                    <span className="skeleton">Reading</span>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                </dd>
                <dt>Published version</dt>
                <dd>
                  {v?.latestVersion ? (
                    <span className="id">{v.latestVersion}</span>
                  ) : v ? (
                    <Unreported why="The gateway reports no published version. The lookup either failed or updates are switched off for this install, and it reports both the same way." />
                  ) : version.loading ? (
                    <span className="skeleton">Reading</span>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                </dd>
                <dt>Update</dt>
                <dd>
                  {updateState === 'available' ? (
                    <span className="status" data-tone="warn">
                      Update available
                    </span>
                  ) : updateState === 'current' ? (
                    <span className="status" data-tone="ok">
                      Up to date
                    </span>
                  ) : updateState === 'unknown' ? (
                    <Unreported why="A failed lookup is not the same as being current, so this screen will not claim either." />
                  ) : version.loading ? (
                    <span className="skeleton">Reading</span>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                </dd>
              </dl>
            </Card>

            <Card
              id="unreported"
              label="Not reported by any route"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-warning" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Not reported by any route</strong>
                    <small>Named rather than guessed</small>
                  </div>
                </>
              }
            >
              <dl className="system-facts">
                <dt>Restart after replacement</dt>
                <dd>
                  <Unreported why="No route reports whether a supervisor is running, so whether a replacement restarts on its own or waits for a hand cannot be read from here." />
                </dd>
                <dt>Data directory</dt>
                <dd>
                  <Unreported why="The gateway resolves this path internally and serves it on no route." />
                </dd>
                <dt>Database file</dt>
                <dd>
                  <Unreported why="The gateway resolves this path internally and serves it on no route." />
                </dd>
                <dt>Timers and background jobs</dt>
                <dd>
                  <Unreported why="Token refresh and the checkpoint timers run in process and report on no route. The model catalogue sync reports its own schedule under Models." />
                </dd>
              </dl>
            </Card>
          </BoardGroup>

          {visibleChecks.length ? (
            <BoardGroup
              label="Health checks"
              tone={counts.bad ? 'refusal' : counts.warn ? 'ember' : 'positive'}
              count={visibleChecks.length}
            >
              {visibleChecks.map((check) => (
                <Card
                  key={check.id}
                  id={check.id}
                  bucket={
                    (TONE[check.status] || 'warn') === 'bad'
                      ? 'attention'
                      : (TONE[check.status] || 'warn') === 'warn'
                        ? 'low'
                        : undefined
                  }
                  label={check.name}
                  head={
                    <>
                      <span className={styles.mark} aria-hidden="true">
                        <Icon name={check.href ? 'i-connections' : 'i-now'} />
                      </span>
                      <div className={board.identityText}>
                        {check.href ? (
                          <Link className={styles.name} href={check.href} prefetch={false}>
                            {check.name}
                          </Link>
                        ) : (
                          <strong>{check.name}</strong>
                        )}
                        <small>{check.sub}</small>
                      </div>
                    </>
                  }
                  state={
                    <StateWord tone={STATE_TONE[TONE[check.status]] || null}>
                      {WORDS[check.status] || check.status || 'Not reported'}
                    </StateWord>
                  }
                >
                  {check.lines.map(([label, value]) => (
                    <FactLine key={label} label={label} value={value} />
                  ))}
                </Card>
              ))}
            </BoardGroup>
          ) : null}

          <BoardGroup label="Capacity and eligibility" count={2}>
            <AdmissionControls
              advanced={advanced}
              expanded={open === 'admission'}
              onToggle={() => setOpen((current) => (current === 'admission' ? null : 'admission'))}
            />
            <Card
              id="eligibility"
              label="Routing eligibility"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-warning" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Routing eligibility</strong>
                    <small>Separate from provider health</small>
                  </div>
                </>
              }
            >
              <p className={styles.aside}>
                An account can read healthy while a model cooldown or quota threshold still prevents new
                work. Eligibility is evaluated now; a retained routing decision records what was known then.
              </p>
              <span className={styles.actions}>
                <Button component={Link} href="/dashboard" size="compact-xs" variant="default">
                  Inspect Capacity
                </Button>
              </span>
            </Card>
          </BoardGroup>

          <BoardGroup label="Configuration" count={3}>
            <Card
              id="export"
              label="Export configuration"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-copy" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Export configuration</strong>
                    <small>Settings, connections, proxies, keys, plans, aliases, models and pricing</small>
                  </div>
                </>
              }
            >
              <p className={styles.aside}>
                Credentials are readable in this file. Retained history of every kind is excluded.
              </p>
              <span className={styles.actions}>
                <Button size="compact-xs" onClick={() => askFor('export')}>
                  Export configuration
                </Button>
              </span>
            </Card>

            <Card
              id="import"
              bucket="attention"
              label="Import configuration"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-open" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Import configuration</strong>
                    <small>Replaces the configuration tables an export covers</small>
                  </div>
                </>
              }
            >
              <p className={styles.aside}>
                Retained usage, receipts, investigations, rule history and compatibility evidence stay as
                they are.
                {policy.data?.requireLogin === false
                  ? ' Sign-in is off, and this still needs an operator credential plus the password.'
                  : ''}
              </p>
              <FileInput
                size="xs"
                ref={importFileInput}
                label="Backup file"
                placeholder="Choose a JSON backup"
                accept="application/json,.json"
                disabled={busy || ask === 'import'}
                value={file}
                onChange={setFile}
              />
              <span className={styles.actions}>
                <Button
                  size="compact-xs"
                  color="red"
                  disabled={!file || busy}
                  onClick={() => askFor('import')}
                >
                  Import configuration
                </Button>
              </span>
              {askStrip('import')}
              {done?.at === 'import' ? (
                <Notice tone={done.tone} title={done.title} next={done.next} />
              ) : null}
            </Card>

            <Card
              id="workflows"
              label="Configuration and evidence workflows"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-tune" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Configuration workflows</strong>
                    <small>Each retains or changes a different scope</small>
                  </div>
                </>
              }
            >
              <ul className={styles.bullets}>
                <li>
                  <Link href="/dashboard/models">Configuration versions</Link>: routing plans, aliases and
                  plan strategies, with rollback.
                </li>
                <li>
                  <Link href="/dashboard/connections">Release activation</Link>: its own record and expected
                  version. A draft is not a release.
                </li>
                <li>
                  <Link href="/dashboard/compatibility">Compatibility evidence</Link>: a fixture revision and
                  a run receipt, changing no routing state.
                </li>
              </ul>
            </Card>
          </BoardGroup>

          <BoardGroup label="Maintenance" tone="refusal" count={2}>
            <Card
              id="update"
              bucket="attention"
              label="Update"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-refresh" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Update</strong>
                    <small>Stops the gateway, so every tool routed through it stops too</small>
                  </div>
                </>
              }
              state={
                <StateWord tone={updateState === 'available' ? 'ember' : null}>
                  {updateState === 'available' ? `${v.latestVersion} published` : 'No newer version reported'}
                </StateWord>
              }
            >
              {notes.state === 'ready' ? (
                <details className={styles.notesToggle}>
                  <summary>Release notes</summary>
                  <pre className="system-notes">{notes.text}</pre>
                </details>
              ) : notes.state === 'empty' ? (
                <p className={styles.aside}>The release notes are empty.</p>
              ) : notes.state === 'unavailable' ? (
                <p className={styles.aside}>The release notes could not be read.</p>
              ) : (
                <p className={styles.aside}>Reading release notes…</p>
              )}
              <span className={styles.actions}>
                <Button
                  size="compact-xs"
                  color="red"
                  onClick={() => askFor('update')}
                >
                  Update now
                </Button>
              </span>
              {askStrip('update')}
              {done?.at === 'update' ? <Notice tone={done.tone} title={done.title} next={done.next} /> : null}
            </Card>

            <Card
              id="shutdown"
              bucket="attention"
              label="Shutdown"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-pause" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Shutdown</strong>
                    <small>Also releases the files a manual reinstall needs</small>
                  </div>
                </>
              }
            >
              <p className={styles.aside}>
                This is the way to stop the gateway before replacing it by hand.
              </p>
              <span className={styles.actions}>
                <Button
                  size="compact-xs"
                  color="red"
                  onClick={() => askFor('shutdown')}
                >
                  Shut down
                </Button>
              </span>
              {askStrip('shutdown')}
              {done?.at === 'shutdown' ? (
                <Notice tone={done.tone} title={done.title} next={done.next} />
              ) : null}
            </Card>
          </BoardGroup>

          <div className={board.messages}>
            {detail.loading && !detail.data ? (
              <div className={board.empty}>
                <Loader size="xs" /> Reading readiness checks…
              </div>
            ) : null}
            {detail.data && !conns.length ? (
              <div className={board.empty}>No connection is configured. Add one under Connections.</div>
            ) : null}
            {checks.length && !visibleChecks.length ? (
              <div className={board.empty}>
                No check matches.{' '}
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
