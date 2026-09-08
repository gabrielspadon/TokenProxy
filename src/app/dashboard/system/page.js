'use client';
import { Button, Input } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import './styles.css';
import { usePoll } from '@/shared/hooks/usePoll';
import { Confirm } from '@/shared/components/Confirm';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { TaskNavigation, taskPanelClass } from '@/shared/components/TaskNavigation';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import { fmtDuration, fmtNum, fmtTime, fmtUnit } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';

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

const BACKUP_HOLDS =
  'Writes a configuration file with readable connection credentials and client keys. Retained usage, operations, investigations, rules, compatibility and routing-version history are excluded. The gateway is unchanged.';

export default function SystemPage() {
  const [task, setTask] = useState('status');
  const health = usePoll('/api/admin/health', 15000);
  const detail = usePoll('/api/admin/health/detail', 15000);
  const version = usePoll('/api/version', 0);
  const policy = usePoll('/api/settings/require-login', 0);
  const [notes, setNotes] = useState({ state: 'loading', text: '' });
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState(null);
  const [done, setDone] = useState(null);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
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
  const updateState = !v
    ? null
    : v.hasUpdate
      ? 'available'
      : v.latestVersion
        ? 'current'
        : 'unknown';

  const close = () => {
    setOpen(null);
    setRefuse(null);
    setPassword('');
    setFile(null);
    if (importFileInput.current) importFileInput.current.value = '';
  };
  const finish = (at, title, next) => {
    setOpen(null);
    setFile(null);
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
      setFile(null);
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
        setOpen(null);
        setDone({ at: 'import', tone: 'warn', title: 'Database imported; runtime refresh incomplete.', next: body.message || 'Read the restored configuration and resolve the reported runtime refresh failure. Do not automatically repeat the import.' });
        detail.refresh(); policy.refresh();
        return;
      }
      setFile(null);
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

  return (
    <>
      <div className="screen-head">
        <h1>System</h1>
        <Button component={Link} href="/dashboard/operations" variant="default">Operation history</Button>
        <Freshness status={pollFresh(health)} lastDataAt={health.goodAt} />
      </div>
      <TaskNavigation label="System tasks" value={task} onChange={setTask} items={[{ value: 'status', label: 'Status', icon: 'i-now' }, { value: 'configuration', label: 'Configuration', icon: 'i-tune' }, { value: 'maintenance', label: 'Maintenance', icon: 'i-system' }]} />

      {health.data || detail.data ? (
        <div className="measures system-summary" aria-label="System observation summary">
          {health.data ? (
            <div className="measure">
              <span className="label">Uptime</span>
              <span className="value">
                {fmtDuration(health.data.uptimeSeconds * 1000)}
              </span>
            </div>
          ) : null}
          {detail.data ? (
            <div className="measure">
              <span className="label">Checks</span>
              <span className="value">
                {fmtNum(conns.length + 1)}
              </span>
            </div>
          ) : null}
          {rollup ? (
            <div className="measure">
              <span className="label">Overall</span>
              <span className="value">{WORDS[rollup] || rollup}</span>
            </div>
          ) : null}
          {db && db.latencyMs !== null && db.latencyMs !== undefined ? (
            <div className="measure">
              <span className="label">Database latency</span>
              <span className="value">
                {fmtUnit(db.latencyMs, 'millisecond')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {task !== 'status' && (health.error || detail.error || version.error) ? <div role="status"><Notice tone="warn" title="Some system observations could not be refreshed." next="Retained values may be stale. Review Status for the failed read and its retry control." /><Button variant="subtle" onClick={() => setTask('status')}>Review system status</Button></div> : null}
      <section aria-labelledby="h-runtime" className={taskPanelClass} data-task-panel hidden={task !== 'status'}>
        <h2 id="h-runtime">
          <Icon name="i-system" />
          Runtime
        </h2>
        {health.error ? <>
          <Notice {...(health.data && (health.status === 0 || health.error.code === 'network')
            ? { tone: 'warn', title: 'Process health could not be refreshed.', next: 'Showing the last successful observation. Current liveness is unknown until the next successful read.' }
            : refusal(health.status, health.error))} />
          <Button type="button" variant="default" onClick={health.refresh} disabled={health.loading}>Retry process health read</Button>
        </> : null}
        {version.error ? (
          <>
            <Notice {...(version.status === 0 || version.error.code === 'network'
              ? { tone: 'bad', title: 'Version information could not be read.', next: 'Retry this read. Process health is reported separately below.' }
              : systemRefusal(version.status, version.error))} />
            <Button type="button" variant="default" onClick={version.refresh} disabled={version.loading}>
              Retry version read
            </Button>
          </>
        ) : null}
        <dl className="facts system-facts">
          <dt>Process</dt>
          <dd>
            {health.data ? (
              <>
                <span className="status" data-tone="ok">
                  Up
                </span>{' '}
                <span>{fmtDuration(health.data.uptimeSeconds * 1000)}</span>
              </>
            ) : health.loading ? (
              <span className="skeleton">Reading</span>
            ) : (
              <span className="status" data-tone="bad">
                Not answering
              </span>
            )}
          </dd>
          <dt>Reading taken</dt>
          <dd>
            {health.data?.generatedAt ? (
              <span>{fmtTime(health.data.generatedAt)}</span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Running version</dt>
          <dd>
            {v?.currentVersion ? (
              <>
                <span className="id">
                  {v.currentVersion}
                </span>
                {v.buildSha ? (
                  <>
                    {' '}
                    <span className="id">
                      {v.buildSha}
                    </span>
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
              <span className="id">
                {v.latestVersion}
              </span>
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
          <dt>Tray mode</dt>
          <dd>{v ? v.isTrayMode ? 'On' : 'Off' : version.loading ? <span className="skeleton">Reading</span> : <span className="unreported">Not reported</span>}</dd>
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
      </section>

      <section aria-labelledby="h-checks" className={taskPanelClass} data-task-panel hidden={task !== 'status'}>
        <div className="screen-head">
          <h2 id="h-checks">
            <Icon name="i-now" />
            Health checks
          </h2>
          <Freshness status={pollFresh(detail)} lastDataAt={detail.goodAt} />
        </div>
        {detail.error ? <>
          <Notice {...(detail.status === 0 || detail.error.code === 'network'
            ? { tone: 'warn', title: 'Readiness checks could not be refreshed.', next: detail.data ? 'Showing the last successful checks. Current database and connection readiness remain unverified.' : 'Retry these checks. Process liveness is reported separately.' }
            : refusal(detail.status, detail.error))} />
          <Button type="button" variant="default" onClick={detail.refresh} disabled={detail.loading}>Retry readiness read</Button>
        </> : null}
        {rollup ? (
          <p className="caption">
            Overall{' '}
            <span className="status" data-tone={TONE[rollup] || 'warn'}>
              {WORDS[rollup] || rollup}
            </span>
          </p>
        ) : null}
        {detail.data?.scanFailed ? (
          <Notice
            tone="warn"
            title="The connection scan did not finish."
            next="The list below may be short. It runs again on the next read."
          />
        ) : null}
        {detail.loading && !detail.data ? <p className="skeleton">Reading</p> : null}
        {detail.data ? (
          <div className="rows">
            <div className="row system-row">
              <span className="who">
                <span className="name">Database</span>
                <span className="sub">
                  {db?.driver ? (
                    <span className="id">
                      {db.driver}
                    </span>
                  ) : null}
                  {db && db.latencyMs !== null && db.latencyMs !== undefined ? (
                    <>
                      {' '}
                      <span>{fmtUnit(db.latencyMs, 'millisecond')}</span>
                    </>
                  ) : null}
                  {db?.error ? (
                    <>
                      {' '}
                      <span>{db.error}</span>
                    </>
                  ) : null}
                </span>
              </span>
              {db ? (
                <span className="status" data-tone={TONE[db.status] || 'warn'}>
                  {WORDS[db.status] || db.status}
                </span>
              ) : (
                <span className="unreported">Not reported</span>
              )}
            </div>
            {conns.map((c) => (
              <div key={c.connectionId} className="row system-row">
                <span className="who">
                  <Link
                    className="name"
                    href={`/dashboard/connections/${c.connectionId}`}
                    prefetch={false}

                  >
                    {c.displayName || c.provider}
                  </Link>
                  <span className="sub">
                    <span>{c.provider}</span>
                    {c.lastError ? (
                      <>
                        {' '}
                        <span>{c.lastError}</span>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="status" data-tone={TONE[c.status] || 'warn'}>
                  {WORDS[c.status] || c.status}
                  {c.isDraining ? (
                    <>
                      {' '}
                      <span>Draining</span>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {detail.data && conns.length === 0 ? (
          <p className="empty">No connection is configured. Add one under Connections.</p>
        ) : null}
      </section>

      <section aria-labelledby="h-configuration-workflows" className={taskPanelClass} data-task-panel hidden={task !== 'configuration'}>
        <h2 id="h-configuration-workflows">Configuration and evidence workflows</h2>
        <p>Each workflow retains or changes a different scope. Review its diff, expected version and receipt before applying another change.</p>
        <ul className="bullets">
          <li><Link href="/dashboard/models">Save draft, validate, activate configuration or roll back a configuration version</Link>. Covers routing plans, direct aliases and selected plan strategies. Credentials, account policy, proxy settings, context processing and cascade policy remain outside this version history. Activation affects subsequent request selection.</li>
          <li><Link href="/dashboard/connections">Activate a release</Link>. Uses the release activation record and its own expected version. A configuration draft is not a release.</li>
          <li><Link href="/dashboard/compatibility">Export local compatibility evidence</Link>. Retains an exact fixture revision, diagnostic checks and run receipt. It changes no routing or release state.</li>
        </ul>
      </section>

      <section aria-labelledby="h-backup" className={taskPanelClass} data-task-panel hidden={task !== 'configuration'}>
        <h2 id="h-backup">Export configuration</h2>
        <p>
          Export a configuration file containing settings, provider connections and nodes, proxy pools, client keys, routing plans, aliases, custom models and pricing.
        </p>
        <p className="caption">
          Credentials are readable in this file. Usage and attempt history, operation receipts, investigations, notification-rule records, compatibility runs and routing-version history are not included.
        </p>
        {done?.at === 'export' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="panel">
          <h3>Controls</h3>
          <div className="verb-row">
            <Button
              type="button"

              onClick={() => {
                setDone(null);
                setOpen('export');
              }}
            >
              Export configuration
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-import" className={taskPanelClass} data-task-panel hidden={task !== 'configuration'}>
        <h2 id="h-import">Import configuration</h2>
        <p>
          Import replaces the configuration tables and scopes included in an export. Existing usage, operation receipts, investigations, rule history and compatibility evidence are not restored from this file and remain separate.
        </p>
        {policy.data?.requireLogin === false ? (
          <p className="caption">
            Sign-in is turned off, and shutdown, update and database import still require an
            operator credential. The database also needs the password.
          </p>
        ) : null}
        {done?.at === 'import' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="panel" data-tone="danger">
          <h3>Controls</h3>
          <label className="field">
            <span>Backup file</span>
            <Input
              ref={importFileInput}
              type="file"
              accept="application/json,.json"
              disabled={busy || open === 'import'}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          {file ? <p className="caption">Selected file {file.name}. Review the replacement scope before importing.</p> : null}
          <div className="verb-row">
            <Button
              type="button"
              color="red"
              disabled={!file || busy}
              onClick={() => {
                setDone(null);
                setOpen('import');
              }}
            >
              Import configuration
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-update" className={taskPanelClass} data-task-panel hidden={task !== 'maintenance'}>
        <h2 id="h-update">Update</h2>
        <p>Updating stops the gateway, so every tool routed through it stops with it.</p>
        {notes.state === 'ready' ? (
          <details>
            <summary>Release notes</summary>
            <pre className="system-notes">
              {notes.text}
            </pre>
          </details>
        ) : notes.state === 'empty' ? (
          <p className="empty">The release notes are empty.</p>
        ) : notes.state === 'unavailable' ? (
          <p className="caption">The release notes could not be read.</p>
        ) : (
          <p className="skeleton">Reading</p>
        )}
        {done?.at === 'update' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="panel" data-tone="danger">
          <h3>Controls</h3>
          <div className="verb-row">
            <Button
              type="button"
              color="red"
              onClick={() => {
                setDone(null);
                setOpen('update');
              }}
            >
              Update now
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-shutdown" className={taskPanelClass} data-task-panel hidden={task !== 'maintenance'}>
        <h2 id="h-shutdown">Shutdown</h2>
        <p>
          Shutting down also releases the files a manual reinstall needs, so this is the way to stop
          the gateway before replacing it by hand.
        </p>
        {done?.at === 'shutdown' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="panel" data-tone="danger">
          <h3>Controls</h3>
          <div className="verb-row">
            <Button
              type="button"
              color="red"
              onClick={() => {
                setDone(null);
                setOpen('shutdown');
              }}
            >
              Shut down
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-gap" className={taskPanelClass} data-task-panel hidden={task !== 'status'}>
        <h2 id="h-gap">
          <Icon name="i-alert" />
          Routing eligibility
        </h2>
        <p>
          Provider health and routing eligibility are separate. An account can have a healthy
          reported status while a model cooldown or quota threshold prevents new work.
        </p>
        <ul className="bullets">
          <li>
            <Link href="/dashboard">Inspect Capacity</Link> for model-scoped eligibility, exclusion
            reasons, quota observations and account controls.
          </li>
          <li>
            Eligibility is a current policy evaluation. A retained routing decision records the
            evidence available when that request was dispatched.
          </li>
        </ul>
      </section>

      <Confirm
        open={open === 'export'}
        title="Export configuration"
        verb="Export configuration"
        requires="The dashboard password."
        changes={BACKUP_HOLDS}
        undo="Delete the file. The gateway itself is unchanged either way."
        busy={busy}
        refusal={refuse}
        onConfirm={doExport}
        onClose={close}
      >
        <label className="field">
          <span>Dashboard password</span>
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </Confirm>

      <Confirm
        open={open === 'import'}
        title="Import configuration"
        verb="Import configuration"
        irreversible
        requires="The dashboard password, and a backup file written by an export."
        changes="Replaces settings, provider connections and nodes, proxy pools, client keys, routing plans, aliases, custom models and pricing with the file contents. Usage, operation, investigation, notification-rule and compatibility history are outside this import scope."
        undo="Export the current configuration first if you may need to restore it. Retained history is outside this export."
        busy={busy}
        refusal={refuse}
        onConfirm={doImport}
        onClose={close}
      >
        <p>Selected file <strong>{file?.name || 'No file selected'}</strong></p>
        <label className="field">
          <span>Dashboard password</span>
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </Confirm>

      <Confirm
        open={open === 'update'}
        title="Update now"
        verb="Update now"
        irreversible
        requires="An operator credential. This holds even when sign-in is turned off."
        changes="Installs the published version and stops this process. Every request in flight is cut."
        undo="Nothing here. Install the earlier version by hand to go back."
        busy={busy}
        refusal={refuse}
        onConfirm={() =>
          post(
            '/api/version/update',
            'update',
            'The updater started.',
            'This process exits in a moment. It comes back on its own only if something supervises it.'
          )
        }
        onClose={close}
      >
        <dl className="facts">
          <dt>Running</dt>
          <dd className="id">
            {v?.currentVersion || '?'}
          </dd>
          <dt>Published</dt>
          <dd>
            {v?.latestVersion ? (
              <span className="id">
                {v.latestVersion}
              </span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
        </dl>
      </Confirm>

      <Confirm
        open={open === 'shutdown'}
        title="Shut down"
        verb="Shut down"
        irreversible
        requires="An operator credential. This holds even when sign-in is turned off."
        changes="Stops the process. Every request in flight is cut, and every client is refused."
        undo="Nothing here. Start TokenProxy again by hand on the machine that runs it."
        busy={busy}
        refusal={refuse}
        onConfirm={() =>
          post(
            '/api/version/shutdown',
            'shutdown',
            'Shutting down.',
            'Every client is refused until you start TokenProxy again by hand.'
          )
        }
        onClose={close}
      />
    </>
  );
}
