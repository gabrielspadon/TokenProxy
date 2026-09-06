'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import './styles.css';
import { usePoll } from '@/shared/hooks/usePoll';
import { Confirm } from '@/shared/components/Confirm';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import { fmtDuration, fmtTime, fmtUnit } from '@/shared/format';
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
  return body?.message && !r.detail ? { ...r, detail: body.message } : r;
}

const BACKUP_HOLDS =
  'Nothing on the gateway. It writes one file holding every connection credential and every client key in readable form.';

export default function SystemPage() {
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
  };
  const finish = (at, title, next) => {
    setOpen(null);
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
      a.download = `tokenproxy-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setFile(null);
      finish(
        'export',
        'The backup file was written.',
        'It holds every credential in readable form, so keep it where you would keep a password.'
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
      setFile(null);
      finish(
        'import',
        'The database was replaced.',
        'Reload the dashboard to read the restored connections, keys and settings.'
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
        <Freshness status={pollFresh(health)} lastDataAt={health.goodAt} />
      </div>

      <section aria-labelledby="h-runtime">
        <h2 id="h-runtime">Runtime</h2>
        {health.error && !health.data ? <Notice {...refusal(health.status, health.error)} /> : null}
        <dl className="facts system-facts">
          <dt>Process</dt>
          <dd>
            {health.data ? (
              <>
                <span className="status" data-tone="ok">
                  Up
                </span>{' '}
                <span data-i18n-skip>{fmtDuration(health.data.uptimeSeconds * 1000)}</span>
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
              <span data-i18n-skip>{fmtTime(health.data.generatedAt)}</span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Running version</dt>
          <dd>
            {v?.currentVersion ? (
              <>
                <span className="id" data-i18n-skip>
                  {v.currentVersion}
                </span>
                {v.buildSha ? (
                  <>
                    {' '}
                    <span className="id" data-i18n-skip>
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
              <span className="id" data-i18n-skip>
                {v.latestVersion}
              </span>
            ) : v ? (
              <Unreported why="The gateway reports no published version. The lookup either failed or updates are switched off for this install, and it reports both the same way." />
            ) : (
              <span className="skeleton">Reading</span>
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
            ) : (
              <span className="skeleton">Reading</span>
            )}
          </dd>
          <dt>Tray mode</dt>
          <dd>{v ? v.isTrayMode ? 'On' : 'Off' : <span className="skeleton">Reading</span>}</dd>
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
            <Unreported why="Token refresh, the tunnel watchdog and the checkpoint timers run in process and report on no route. The model catalogue sync reports its own schedule under Models." />
          </dd>
        </dl>
      </section>

      <section aria-labelledby="h-checks">
        <div className="screen-head">
          <h2 id="h-checks">Health checks</h2>
          <Freshness status={pollFresh(detail)} lastDataAt={detail.goodAt} />
        </div>
        {detail.error && !detail.data ? <Notice {...refusal(detail.status, detail.error)} /> : null}
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
                    <span className="id" data-i18n-skip>
                      {db.driver}
                    </span>
                  ) : null}
                  {db && db.latencyMs !== null && db.latencyMs !== undefined ? (
                    <>
                      {' '}
                      <span data-i18n-skip>{fmtUnit(db.latencyMs, 'millisecond')}</span>
                    </>
                  ) : null}
                  {db?.error ? (
                    <>
                      {' '}
                      <span data-i18n-skip>{db.error}</span>
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
                    data-i18n-skip
                  >
                    {c.displayName || c.provider}
                  </Link>
                  <span className="sub">
                    <span data-i18n-skip>{c.provider}</span>
                    {c.lastError ? (
                      <>
                        {' '}
                        <span data-i18n-skip>{c.lastError}</span>
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

      <section aria-labelledby="h-backup">
        <h2 id="h-backup">Backup</h2>
        <p>
          A backup is one JSON file holding every setting, connection, client key and combo this
          gateway stores.
        </p>
        <p className="caption">
          Credentials are inside it in readable form, so treat the file as a password.
        </p>
        {done?.at === 'export' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              setDone(null);
              setOpen('export');
            }}
          >
            Export a backup
          </button>
        </div>
      </section>

      <section aria-labelledby="h-import">
        <h2 id="h-import">Database</h2>
        <p>
          Importing a backup replaces the whole database. Everything stored now is destroyed first.
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
        <div className="actions">
          <button
            type="button"
            className="button danger"
            onClick={() => {
              setDone(null);
              setOpen('import');
            }}
          >
            Import a database
          </button>
        </div>
      </section>

      <section aria-labelledby="h-update">
        <h2 id="h-update">Update</h2>
        <p>Updating stops the gateway, so every tool routed through it stops with it.</p>
        {notes.state === 'ready' ? (
          <details>
            <summary>Release notes</summary>
            <pre className="system-notes" data-i18n-skip>
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
        <div className="actions">
          <button
            type="button"
            className="button danger"
            onClick={() => {
              setDone(null);
              setOpen('update');
            }}
          >
            Update now
          </button>
        </div>
      </section>

      <section aria-labelledby="h-shutdown">
        <h2 id="h-shutdown">Shutdown</h2>
        <p>
          Shutting down also releases the files a manual reinstall needs, so this is the way to stop
          the gateway before replacing it by hand.
        </p>
        {done?.at === 'shutdown' ? (
          <Notice tone={done.tone} title={done.title} next={done.next} />
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="button danger"
            onClick={() => {
              setDone(null);
              setOpen('shutdown');
            }}
          >
            Shut down
          </button>
        </div>
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <p>
          Two things the gateway acts on every time it routes reach no readable field, so this
          screen cannot show them.
        </p>
        <ul className="bullets">
          <li>
            Whether a connection is being skipped because a quota window crossed its auto-pause
            threshold. Such a connection reads as healthy above.
          </li>
          <li>
            Whether one model on a connection is locked out after a model-scoped failure, and until
            when.
          </li>
        </ul>
      </section>

      <Confirm
        open={open === 'export'}
        title="Export a backup"
        verb="Export a backup"
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
          <input
            className="input"
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
        title="Import a database"
        verb="Import a database"
        irreversible
        requires="The dashboard password, and a backup file written by an export."
        changes="Replaces the whole database. Every connection, client key, combo and setting stored now is destroyed and replaced by the file's."
        undo="Nothing. Export a backup first if what is stored now still matters."
        busy={busy}
        refusal={refuse}
        onConfirm={doImport}
        onClose={close}
      >
        <label className="field">
          <span>Backup file</span>
          <input
            className="input"
            type="file"
            accept="application/json,.json"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <label className="field">
          <span>Dashboard password</span>
          <input
            className="input"
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
          <dd className="id" data-i18n-skip>
            {v?.currentVersion || '?'}
          </dd>
          <dt>Published</dt>
          <dd>
            {v?.latestVersion ? (
              <span className="id" data-i18n-skip>
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
