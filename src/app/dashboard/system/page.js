'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  FileInput,
  PasswordInput,
  Select,
  Switch,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import AdmissionControls from './AdmissionControls';
import { Row } from './Row';
import { usePoll } from '@/shared/hooks/usePoll';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { CommitNumber } from '@/shared/workspace/CommitFields';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import { fmtDuration, fmtTime, fmtUnit } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';
import {
  Board,
  BoardSummary,
  BoardToolbar,
  DensitySwitch,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './system.module.css';

const STATE_TONE = { ok: 'positive', warn: 'ember', bad: 'refusal' };
const BACKUP_HOLDS =
  'Writes a configuration file with readable connection credentials and client keys. Retained usage, operations, investigations, rules, compatibility and routing-version history are excluded. The gateway is unchanged.';
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });

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

// A reading no route reports: never a zero, and the reason on hover.
function Unreported({ why }) {
  return (
    <Tooltip label={why} multiline w={320}>
      <span className={`${styles.unreported} unreported`}>Not reported</span>
    </Tooltip>
  );
}

export default function SystemPage() {
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const health = usePoll('/api/admin/health', 15000);
  const detail = usePoll('/api/admin/health/detail', 15000);
  const version = usePoll('/api/version', 0);
  const settings = usePoll('/api/settings', 0);
  const [notes, setNotes] = useState({ state: 'loading', text: '' });
  const [showNotes, setShowNotes] = useState(false);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState(null);
  const [done, setDone] = useState(null);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(null);
  const importFileInput = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/changelog', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => alive && setNotes({ state: t.trim() ? 'ready' : 'empty', text: t }))
      .catch(() => alive && setNotes({ state: 'unavailable', text: '' }));
    return () => {
      alive = false;
    };
  }, []);

  const v = version.data;
  const db = detail.data?.checks?.database;
  const conns = detail.data?.checks?.connections || [];
  const counts = conns.reduce((into, c) => {
    const tone = TONE[c.status] || 'warn';
    into[tone] = (into[tone] || 0) + 1;
    return into;
  }, {});
  const current = settings.data || {};
  const updateState = !v
    ? null
    : v.hasUpdate
      ? 'available'
      : v.latestVersion
        ? 'current'
        : 'unknown';

  const cancel = () => {
    setAsk(null);
    setRefuse(null);
    setBusy(false);
    setPassword('');
  };
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
        settings.refresh();
        return;
      }
      finish(
        'import',
        'The database import returned successfully.',
        'Read the restored connections, keys and settings before another mutation. This response does not independently verify every imported record.'
      );
      settings.refresh();
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

  // A setting saves from its own control: write the one key, read the
  // settings back, and say what the gateway now holds.
  const save = async (key, value, label) => {
    setSaving(key);
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(refusal(res.status, body).title);
      const back = await (await fetch('/api/settings', { cache: 'no-store' })).json();
      if (JSON.stringify(back?.[key]) !== JSON.stringify(value))
        throw new Error('The save returned, but the stored value did not read back.');
      toast('teal', `${label} saved and read back.`);
      settings.refresh();
    } catch (error) {
      toast('orange', error.message, label);
    } finally {
      setSaving(null);
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
  // `ask` is only the key of the act being confirmed. Its sentence, body and
  // call are read from ACTS on the current render, so a password typed inside
  // the confirmation is the one that gets sent.
  const ACTS = {
    export: {
      title: 'Export configuration',
      verb: 'Export configuration',
      requires: 'the dashboard password.',
      changes: BACKUP_HOLDS,
      undo: 'Delete the file. The gateway itself is unchanged either way.',
      body: passwordField,
      run: doExport,
    },
    import: {
      title: 'Import configuration',
      verb: 'Import configuration',
      irreversible: true,
      requires: 'the dashboard password, and a backup file written by an export.',
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
      requires: 'an operator credential. This holds even when sign-in is turned off.',
      changes: `Installs ${v?.latestVersion ? `version ${v.latestVersion}` : 'the published version'} over ${v?.currentVersion || 'the running one'} and stops this process. Every request in flight is cut.`,
      undo: 'Install the earlier version by hand to go back.',
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
      requires: 'an operator credential. This holds even when sign-in is turned off.',
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
  const strip = (key) =>
    ask === key ? (
      <div className={styles.confirm}>
        <InlineConfirm
          {...ACTS[key]}
          submit
          busy={busy}
          refusal={refuse}
          onConfirm={ACTS[key].run}
          onCancel={cancel}
        />
      </div>
    ) : null;
  const outcome = (key) =>
    done?.at === key ? (
      <div className={styles.outcome}>
        <Notice tone={done.tone} title={done.title} next={done.next} />
      </div>
    ) : null;

  // A read that failed says so above the rows, with its own retry, and never
  // hides behind a group. A stale read keeps its last good body on the rows.
  const lost = (poll) => poll.status === 0 || poll.error?.code === 'network';
  const readNotices = [
    health.error && {
      key: 'health',
      retry: 'Retry process health read',
      poll: health,
      ...(health.data && lost(health)
        ? {
            tone: 'warn',
            title: 'Process health could not be refreshed.',
            next: 'Showing the last successful observation. Current liveness is unknown until the next successful read.',
          }
        : refusal(health.status, health.error)),
    },
    detail.error && {
      key: 'detail',
      retry: 'Retry readiness read',
      poll: detail,
      ...(lost(detail)
        ? {
            tone: 'warn',
            title: 'Readiness checks could not be refreshed.',
            next: detail.data
              ? 'Showing the last successful checks. Current database and connection readiness remain unverified.'
              : 'Retry these checks. Process liveness is reported separately.',
          }
        : refusal(detail.status, detail.error)),
    },
    version.error && {
      key: 'version',
      retry: 'Retry version read',
      poll: version,
      ...(lost(version)
        ? {
            tone: 'bad',
            title: 'Version information could not be read.',
            next: 'Retry this read. Process health is reported separately below.',
          }
        : systemRefusal(version.status, version.error)),
    },
  ].filter(Boolean);

  const chips = [
    {
      id: 'process',
      tone: health.data ? 'positive' : health.loading ? null : 'refusal',
      count: health.data ? fmtDuration(health.data.uptimeSeconds * 1000) : '—',
      label: health.data ? 'up' : health.loading ? 'reading' : 'not answering',
    },
    {
      id: 'version',
      tone: updateState === 'available' ? 'ember' : updateState === 'current' ? 'positive' : null,
      count: v?.currentVersion || '—',
      label:
        updateState === 'available'
          ? `running, ${v.latestVersion} published`
          : updateState === 'current'
            ? 'running, current'
            : 'running',
    },
    {
      id: 'database',
      tone: db ? STATE_TONE[db.status] || 'ember' : null,
      count: db?.latencyMs != null ? fmtUnit(db.latencyMs, 'millisecond') : '—',
      label: db ? `database ${(WORDS[db.status] || db.status || '').toLowerCase()}` : 'database',
    },
    {
      id: 'accounts',
      tone: counts.bad ? 'refusal' : counts.warn ? 'ember' : 'positive',
      count: conns.length,
      label: `accounts, ${counts.ok || 0} healthy, ${counts.warn || 0} degraded, ${counts.bad || 0} failing`,
    },
  ];

  const numberField = (key, label, extra = {}) => (
    <CommitNumber
      size="xs"
      aria-label={label}
      className={styles.number}
      value={current[key] ?? extra.fallback ?? 0}
      disabled={saving === key || !settings.data}
      onCommit={(next) => save(key, next, label)}
      min={extra.min}
      max={extra.max}
      step={extra.step}
      suffix={extra.suffix}
    />
  );
  const toggle = (key, label) => (
    <Switch
      size="xs"
      aria-label={label}
      checked={current[key] === true}
      disabled={saving === key || !settings.data}
      onChange={(event) => save(key, event.currentTarget.checked, label)}
    />
  );
  const onOff = (key) => (
    <StateWord tone={current[key] ? 'positive' : null}>{current[key] ? 'On' : 'Off'}</StateWord>
  );
  const link = (href, text) => (
    <Button size="compact-xs" variant="subtle" component={Link} href={href}>
      {text}
    </Button>
  );

  // Every row the panel can show, in its group; the search narrows them.
  const rows = [];
  const add = (group, row) => rows.push({ group, ...row });
  add('Runtime', {
    id: 'process',
    label: 'Process',
    hint: 'This gateway, as it runs now',
    control: (
      <span className={styles.reading}>
        {health.data
          ? `Up ${fmtDuration(health.data.uptimeSeconds * 1000)}${health.data.generatedAt ? `, read ${fmtTime(health.data.generatedAt)}` : ''}`
          : health.loading
            ? 'Reading…'
            : 'The health route did not answer.'}
      </span>
    ),
    state: (
      <StateWord tone={health.data ? 'positive' : health.loading ? null : 'refusal'}>
        {health.data ? 'Up' : health.loading ? 'Reading' : 'Not answering'}
      </StateWord>
    ),
  });
  add('Runtime', {
    id: 'version',
    label: 'Version',
    hint: 'Installed here',
    control: (
      <span className={styles.reading}>
        {v?.currentVersion ? (
          <>
            <code>{v.currentVersion}</code>
            {v.buildSha ? (
              <>
                {' '}
                build <code>{v.buildSha}</code>
              </>
            ) : null}
          </>
        ) : version.loading ? (
          'Reading…'
        ) : (
          <Unreported why="The version route did not answer, so the running version is not claimed." />
        )}
      </span>
    ),
    state: v?.isTrayMode ? <StateWord>Tray mode</StateWord> : null,
  });
  add('Runtime', {
    id: 'update',
    label: 'Update',
    hint:
      updateState === 'available'
        ? `Version ${v.latestVersion} is published`
        : updateState === 'current'
          ? 'This is the published version'
          : 'A failed lookup is not the same as being current, so this panel claims neither',
    control:
      updateState === 'available' ? (
        <Button
          size="xs"
          color="orange"
          leftSection={<Icon name="i-refresh" />}
          onClick={() => askFor('update')}
          disabled={ask === 'update'}
        >
          Update now
        </Button>
      ) : (
        <Button
          size="xs"
          variant="default"
          leftSection={<Icon name="i-refresh" />}
          loading={version.loading}
          onClick={() => version.refresh()}
        >
          Check again
        </Button>
      ),
    state:
      updateState === 'available' ? (
        <StateWord tone="ember">Newer version</StateWord>
      ) : updateState === 'current' ? (
        <StateWord tone="positive">Up to date</StateWord>
      ) : (
        <Unreported why="A failed lookup is not the same as being current, so this panel claims neither." />
      ),
  });
  add('Runtime', {
    id: 'notes',
    label: 'Release notes',
    hint:
      notes.state === 'ready'
        ? 'What changed in this and earlier versions'
        : notes.state === 'empty'
          ? 'No notes are shipped with this build'
          : notes.state === 'unavailable'
            ? 'The notes could not be read'
            : 'Reading…',
    control:
      notes.state === 'ready' ? (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => setShowNotes((value) => !value)}
          aria-expanded={showNotes}
        >
          {showNotes ? 'Hide notes' : 'Show notes'}
        </Button>
      ) : null,
    state: null,
  });
  add('Backup', {
    id: 'export',
    label: 'Backup file',
    hint: 'Every credential in readable form; keep it where you would keep a password',
    control: (
      <Button
        size="xs"
        leftSection={<Icon name="i-export" />}
        onClick={() => askFor('export')}
        disabled={ask === 'export'}
      >
        Export configuration
      </Button>
    ),
    state: null,
  });
  add('Backup', {
    id: 'import',
    label: 'Restore',
    hint: 'Replaces the stored configuration with a backup file',
    control: (
      <span className={styles.inline}>
        <FileInput
          size="xs"
          aria-label="Backup file"
          placeholder="Choose a JSON backup"
          accept="application/json,.json"
          value={file}
          onChange={setFile}
          ref={importFileInput}
          className={styles.file}
          clearable
        />
        <Button
          size="xs"
          variant="default"
          disabled={!file || ask === 'import'}
          onClick={() => askFor('import')}
        >
          Import configuration
        </Button>
      </span>
    ),
    state: null,
  });
  if (advanced) {
    add('Reads', {
      id: 'restart',
      label: 'Restart after replacement',
      hint: 'Whether a supervisor brings a replaced process back',
      control: (
        <Unreported why="No route reports whether a supervisor is running, so whether a replacement restarts on its own or waits for a hand cannot be read from here." />
      ),
      state: null,
    });
    add('Reads', {
      id: 'datadir',
      label: 'Data directory',
      hint: 'Where the database and stored credentials live',
      control: (
        <Unreported why="The gateway resolves this path internally and serves it on no route." />
      ),
      state: null,
    });
    add('Reads', {
      id: 'dbfile',
      label: 'Database file',
      hint: 'The SQLite file behind the driver',
      control: (
        <Unreported why="The gateway resolves this path from its data directory and serves it on no route." />
      ),
      state: null,
    });
    add('Reads', {
      id: 'timers',
      label: 'Timers and background jobs',
      hint: 'Token refresh, checkpoints, catalogue sync',
      control: (
        <Unreported why="Token refresh and the checkpoint timers run in process and report on no route. The model catalogue sync reports its own schedule under Models." />
      ),
      state: null,
    });
    add('Retention', {
      id: 'statsRetentionMode',
      label: 'Statistics retention',
      hint: 'Preserve keeps every record; window drops what is older than the retention days',
      control: (
        <Select
          size="xs"
          aria-label="Statistics retention"
          data={[
            { value: 'preserve', label: 'Preserve' },
            { value: 'window', label: 'Window' },
          ]}
          value={current.statsRetentionMode || 'preserve'}
          onChange={(value) => value && save('statsRetentionMode', value, 'Statistics retention')}
          allowDeselect={false}
          className={styles.select}
          disabled={saving === 'statsRetentionMode' || !settings.data}
        />
      ),
      state: null,
    });
    add('Retention', {
      id: 'statsRetentionDays',
      label: 'Retention days',
      hint: 'Applies when retention is windowed, 1 through 365',
      control: numberField('statsRetentionDays', 'Retention days', {
        min: 1,
        max: 365,
        fallback: 45,
      }),
      state:
        current.statsRetentionMode === 'window' ? (
          <StateWord tone="positive">Applied</StateWord>
        ) : (
          <StateWord>Held, retention preserves</StateWord>
        ),
    });
    add('Network defaults', {
      id: 'connectTimeoutMs',
      label: 'Connect timeout',
      hint: 'Milliseconds to reach an upstream before giving up, 1000 through 120000',
      control: numberField('connectTimeoutMs', 'Connect timeout', {
        min: 1000,
        max: 120000,
        step: 500,
        suffix: ' ms',
        fallback: 10000,
      }),
      state: null,
    });
    add('Network defaults', {
      id: 'proxy',
      label: 'Outbound proxy',
      hint: current.outboundProxyEnabled
        ? current.outboundProxyUrl || 'Enabled'
        : 'Direct, no proxy',
      control: link('/dashboard/network', 'Configure on Network'),
      state: onOff('outboundProxyEnabled'),
    });
    add('Observability', {
      id: 'enableObservability',
      label: 'Request observability',
      hint: 'Keeps a bounded record of each request for the workbenches',
      control: toggle('enableObservability', 'Request observability'),
      state: onOff('enableObservability'),
    });
    add('Observability', {
      id: 'observabilityMaxRecords',
      label: 'Records kept',
      hint: 'Oldest records go first past this count',
      control: numberField('observabilityMaxRecords', 'Records kept', { min: 1, fallback: 1000 }),
      state: null,
    });
    add('Observability', {
      id: 'observabilityBatchSize',
      label: 'Batch size',
      hint: 'Records written per flush',
      control: numberField('observabilityBatchSize', 'Batch size', { min: 1, fallback: 20 }),
      state: null,
    });
    add('Observability', {
      id: 'observabilityFlushIntervalMs',
      label: 'Flush interval',
      hint: 'Milliseconds between writes',
      control: numberField('observabilityFlushIntervalMs', 'Flush interval', {
        min: 100,
        step: 100,
        suffix: ' ms',
        fallback: 5000,
      }),
      state: null,
    });
    add('Observability', {
      id: 'observabilityMaxJsonSize',
      label: 'Largest body kept',
      hint: 'Megabytes of JSON kept per record',
      control: numberField('observabilityMaxJsonSize', 'Largest body kept', {
        min: 1,
        suffix: ' MB',
        fallback: 5,
      }),
      state: null,
    });
    add('Sharing', {
      id: 'analyticsEnabled',
      label: 'Anonymous analytics',
      hint: 'Usage counts sent to the project; never prompts or keys',
      control: toggle('analyticsEnabled', 'Anonymous analytics'),
      state: onOff('analyticsEnabled'),
    });
    add('Sharing', {
      id: 'cloudEnabled',
      label: 'Cloud sync',
      hint: 'Mirrors configuration to the cloud service',
      control: toggle('cloudEnabled', 'Cloud sync'),
      state: onOff('cloudEnabled'),
    });
    add('Configuration workflows', {
      id: 'versions',
      label: 'Configuration versions',
      hint: 'Routing plans, aliases and plan strategies, with rollback',
      control: link('/dashboard/models', 'Open on Models'),
      state: null,
    });
    add('Configuration workflows', {
      id: 'release',
      label: 'Release activation',
      hint: 'Its own record and expected version; a draft is not a release',
      control: link('/dashboard/connections', 'Open on Connections'),
      state: null,
    });
    add('Configuration workflows', {
      id: 'compat',
      label: 'Compatibility evidence',
      hint: 'A fixture revision and a run receipt, changing no routing state',
      control: link('/dashboard/compatibility', 'Open on Compatibility'),
      state: null,
    });
    for (const c of conns)
      add('Health checks', {
        id: c.connectionId,
        label: c.displayName || c.provider,
        hint: c.provider,
        control: (
          <span className={styles.reading}>
            {c.lastError ? c.lastError : c.isDraining ? 'Draining' : ''}
          </span>
        ),
        state: (
          <StateWord tone={STATE_TONE[TONE[c.status]] || 'ember'}>
            {WORDS[c.status] || c.status}
          </StateWord>
        ),
      });
  }
  add('Health checks', {
    id: 'database',
    label: 'Database',
    hint: db?.driver || 'Driver not reported',
    control: (
      <span className={styles.reading}>
        {db?.latencyMs != null ? `Latency ${fmtUnit(db.latencyMs, 'millisecond')}` : ''}
        {db?.error ? ` ${db.error}` : ''}
      </span>
    ),
    state: db ? (
      <StateWord tone={STATE_TONE[db.status]}>{WORDS[db.status] || db.status}</StateWord>
    ) : null,
  });
  if (!advanced) {
    add('Health checks', {
      id: 'accounts',
      label: 'Accounts',
      hint: `${counts.ok || 0} healthy, ${counts.warn || 0} degraded, ${counts.bad || 0} failing`,
      control: link('/dashboard', 'Open Capacity'),
      state: (
        <StateWord tone={counts.bad ? 'refusal' : counts.warn ? 'ember' : 'positive'}>
          {counts.bad ? 'Failing' : counts.warn ? 'Degraded' : 'Healthy'}
        </StateWord>
      ),
    });
  }
  add('Stop', {
    id: 'shutdown',
    label: 'Shut down',
    hint: 'Stops the gateway; every client is refused until it is started again by hand',
    control: (
      <Button
        size="xs"
        color="red"
        variant="light"
        leftSection={<Icon name="i-power" />}
        onClick={() => askFor('shutdown')}
        disabled={ask === 'shutdown'}
      >
        Shut down
      </Button>
    ),
    state: null,
  });

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? rows.filter((row) =>
        `${row.label} ${row.hint || ''} ${row.group}`.toLowerCase().includes(needle)
      )
    : rows;
  const groups = [...new Set(shown.map((row) => row.group))];
  const groupTone = {
    Stop: 'refusal',
    'Health checks': counts.bad ? 'refusal' : counts.warn ? 'ember' : 'positive',
  };

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>System</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · the gateway process, its version, backups and the
            switches that shape it
          </p>
        </div>
        <Button
          size="xs"
          variant="default"
          component={Link}
          href="/dashboard/operations"
          leftSection={<Icon name="i-sessions" />}
        >
          Operation history
        </Button>
      </div>
      <div className={shared.lensBody}>
        <Board label="System" advanced={advanced} density={density} layout="rows" compare="none">
          <BoardSummary
            label="System summary"
            chips={chips}
            note={
              advanced
                ? 'Every reading and switch'
                : 'Advanced adds retention, observability, sharing and every reading'
            }
          />
          <BoardToolbar
            search={query}
            onSearch={setQuery}
            searchLabel="Search settings"
            actions={
              <>
                <DensitySwitch value={density} onChange={setDensity} />
                <Tooltip label="Re-read process health, readiness, version and settings">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh system reads"
                    onClick={() => {
                      health.refresh();
                      detail.refresh();
                      version.refresh();
                      settings.refresh();
                    }}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          />
          {readNotices.map((notice) => (
            <Notice
              key={notice.key}
              tone={notice.tone}
              title={notice.title}
              next={notice.next}
              detail={notice.detail}
            >
              <Button
                size="compact-xs"
                variant="default"
                onClick={notice.poll.refresh}
                disabled={notice.poll.loading}
              >
                {notice.retry}
              </Button>
            </Notice>
          ))}
          {groups.map((group) => (
            <Fragment key={group}>
              <section
                className={styles.group}
                aria-label={`${group} settings`}
                data-tone={groupTone[group]}
              >
                <h3 className={styles.groupTitle}>
                  <i />
                  {group}
                  <span>{shown.filter((row) => row.group === group).length}</span>
                </h3>
                <div className={styles.rows}>
                  {shown
                    .filter((row) => row.group === group)
                    .map((row) => (
                      <div key={row.id} data-setting={row.id}>
                        <Row {...row} />
                        {row.id === 'notes' && showNotes && notes.state === 'ready' ? (
                          <pre className={styles.notes}>{notes.text}</pre>
                        ) : null}
                        {strip(row.id)}
                        {outcome(row.id)}
                      </div>
                    ))}
                </div>
              </section>
              {group === 'Backup' && !needle ? <AdmissionControls advanced={advanced} /> : null}
            </Fragment>
          ))}
          {!shown.length ? (
            <div className={styles.empty}>
              No setting matches. Clear the search to see every row.
            </div>
          ) : null}
        </Board>
      </div>
    </div>
  );
}
