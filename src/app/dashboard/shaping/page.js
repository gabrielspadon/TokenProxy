'use client';
import { useMemo, useState } from 'react';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Measure } from '@/shared/components/Measure';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtPct, fmtRelative, fmtUnit } from '@/shared/format';
import './styles.css';

// One row per settings flag. `stage` is the id the byte ledger measures under,
// so several flags can share one stage and say so.
const LAYERS = [
  { key: 'rtkEnabled', stage: 'rtk', name: 'Tool result reducer' },
  { key: 'memoryToolPruningEnabled', stage: 'mem', name: 'History pruning, tool turns' },
  { key: 'memoryMediaPruningEnabled', stage: 'mem', name: 'History pruning, attachments' },
  { key: 'memoryCompactionEnabled', stage: 'mem', name: 'History compaction' },
  { key: 'memoryHandoffEnabled', stage: 'mem', name: 'Handoff summary' },
  { key: 'toolDisclosureEnabled', stage: 'tools', name: 'Tool list filtering' },
  { key: 'toolDisclosureFilterEnabled', stage: 'tools', name: 'Tool list exclusions' },
  { key: 'privacyFilterEnabled', stage: 'privacy', name: 'Term filtering' },
  { key: 'pxpipeEnabled', stage: 'pxpipe', name: 'Compression service' },
  { key: 'schemaDistillEnabled', stage: 'schema', name: 'Tool schema distilling' },
  { key: 'thinkingStripEnabled', stage: 'thinking', name: 'Thinking block strip' },
  { key: 'queryAwareCompressionEnabled', stage: 'qac', name: 'Query aware compression' },
  { key: 'pairDropEnabled', stage: 'pairs', name: 'Turn pair dropping' },
  { key: 'embedReorderEnabled', stage: 'reorder', name: 'Embedding reorder' },
  { key: 'midPrefixInjectEnabled', stage: 'midinject', name: 'Boundary note' },
  { key: 'cavemanEnabled', stage: 'inject', name: 'Caveman prompt' },
  { key: 'ponytailEnabled', stage: 'inject', name: 'Ponytail prompt' },
  { key: 'headroomEnabled', stage: 'headroom', name: 'Headroom proxy' },
];
const STAGES = [...new Set(LAYERS.map((l) => l.stage))];
// Panel grouping only; every layer still switches on its own flag above.
const GROUPS = [
  { title: 'History', stages: ['mem', 'pairs', 'reorder'] },
  { title: 'Tool traffic', stages: ['rtk', 'tools', 'schema'] },
  { title: 'Compression', stages: ['pxpipe', 'qac'] },
  { title: 'Prompt injection', stages: ['inject', 'midinject', 'thinking'] },
  { title: 'Safeguards', stages: ['privacy', 'headroom'] },
];
const THRESHOLDS = [
  { key: 'pxpipeMinChars', name: 'Smallest request worth compressing', unit: 'character' },
  { key: 'pxpipeTimeoutMs', name: 'Time to wait before abandoning', unit: 'millisecond' },
  { key: 'memoryMaxToolTurnsKeepFull', name: 'Recent tool turns kept whole', unit: null },
  { key: 'memoryMaxHistoricalToolChars', name: 'Ceiling on an older tool turn', unit: 'character' },
  { key: 'memoryRecentTurnsToKeep', name: 'Recent turns kept intact', unit: null },
  { key: 'memoryCompactionThresholdTokens', name: 'Compact past this size', unit: null },
  { key: 'toolDisclosureMaxTools', name: 'Most tools disclosed upstream', unit: null },
];
const SERVICE = {
  start: {
    verb: 'Start',
    title: 'Start the compression service',
    changes:
      'Loads the module into this process. It installs the package first when it is missing and automatic install is on.',
    undo: 'Stop it again here.',
    done: 'Start finished.',
  },
  stop: {
    verb: 'Stop',
    title: 'Stop the compression service',
    changes:
      'Drops the loaded module, so new requests pass through uncompressed. A request already mid-transform finishes on the copy it holds.',
    undo: 'Start it again here.',
    done: 'Stop finished.',
  },
  restart: {
    verb: 'Restart',
    title: 'Restart the compression service',
    changes:
      'Unloads and reloads the module, picking up an upgraded install without restarting the gateway.',
    undo: 'None needed. Restart again if it comes back wrong.',
    done: 'Restart finished.',
  },
  install: {
    verb: 'Install',
    title: 'Install the compression service',
    changes:
      'Fetches the current version, discards the loaded copy and runs the health check. It overwrites any previous installation and can take minutes.',
    undo: 'None. The previous installation is gone. Install again to replace it.',
    irreversible: true,
    done: 'Install finished.',
  },
};
const OPERATOR = 'A signed-in operator session on the machine that runs the gateway.';
const TURN_ON_CHANGES =
  'New requests run this layer. New requests take the change. A request already in flight keeps the stack it started with.';
const TURN_OFF_CHANGES =
  'New requests skip this layer. New requests take the change. A request already in flight keeps the stack it started with.';
const SAVE_CHANGES =
  'New requests use the new numbers. New requests take the change. A request already in flight keeps the stack it started with.';

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// bytesSaved is signed: negative saved bytes, positive grew the body.
const saved = (s) => (s && s.bytesSaved < 0 ? -s.bytesSaved : 0);

export default function ShapingPage() {
  const settings = usePoll('/api/settings', 30000);
  const stats = usePoll('/api/token-saver/stats', 15000);
  const status = usePoll('/api/pxpipe/status', 15000);
  const health = usePoll('/api/pxpipe/health', 60000);
  const logs = usePoll('/api/pxpipe/logs?limit=20', 60000);
  const disclosure = usePoll('/api/tool-disclosure/stats', 30000);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [done, setDone] = useState(null);
  const [draft, setDraft] = useState({});

  const s = settings.data;
  const all = stats.data?.windows?.all;
  const today = stats.data?.windows?.today;
  const px = stats.data?.pxpipe;
  const stageMap = all?.stages || {};
  const totalSaved = STAGES.reduce((n, id) => n + saved(stageMap[id]), 0);
  const chains = useMemo(
    () =>
      Object.entries(s?.comboStrategies || {})
        .filter(([, v]) => v && v.tokenSaver)
        .map(([name, v]) => ({ name, keys: Object.keys(v.tokenSaver) })),
    [s]
  );
  const timeline = (px?.timeline || []).filter((d) => d.requests > 0);
  const turns = Array.isArray(disclosure.data) ? disclosure.data : [];

  const run = async () => {
    setBusy(true);
    setFailed(null);
    const r = pending.url
      ? await call(pending.url, { method: 'POST' })
      : await call('/api/settings', { method: 'PATCH', body: pending.body });
    setBusy(false);
    if (!r.ok) {
      setFailed(refusal(r.status, r.body));
      return;
    }
    setDone(pending.done);
    setPending(null);
    settings.refresh();
    status.refresh();
    health.refresh();
  };
  const close = () => {
    setPending(null);
    setFailed(null);
  };
  const toggle = (l, on) =>
    setPending({
      verb: on ? 'Turn on' : 'Turn off',
      title: on ? 'Turn on a layer' : 'Turn off a layer',
      // The layer name is its own text node, so no sentence is split by it.
      layer: l.name,
      changes: on ? TURN_ON_CHANGES : TURN_OFF_CHANGES,
      undo: on ? 'Turn it off again here.' : 'Turn it back on here. Numbers already recorded stay.',
      body: { [l.key]: on },
      done: on ? 'Turned on.' : 'Turned off.',
    });
  const act = (id) => setPending({ ...SERVICE[id], url: `/api/pxpipe/${id}` });
  const save = () =>
    setPending({
      verb: 'Save',
      title: 'Save the thresholds',
      changes: SAVE_CHANGES,
      undo: 'Set the previous numbers back here.',
      body: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])),
      done: 'Saved.',
    });

  return (
    <>
      <div className="screen-head">
        <h1>Shaping</h1>
        <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
      </div>

      <section aria-labelledby="h-layers">
        <h2 id="h-layers">Layers</h2>
        <p>
          Each layer rewrites a request before it leaves for its provider, and each switches on its
          own.
        </p>
        {settings.error && !s ? <Notice {...refusal(settings.status, settings.error)} /> : null}
        {done ? <Notice tone="ok" title={done} /> : null}
        {!s && settings.loading ? <p className="skeleton">Reading</p> : null}
        <div className="panel-grid">
          {s
            ? GROUPS.map((g) => {
                const members = LAYERS.filter((l) => g.stages.includes(l.stage));
                const onCount = members.filter((l) => !!s[l.key]).length;
                return (
                  <div key={g.title} className="panel">
                    <div className="panel-head">
                      <h3>{g.title}</h3>
                      <span className="caption">
                        <span data-i18n-skip>
                          {fmtNum(onCount)} / {fmtNum(members.length)}
                        </span>{' '}
                        <span>on</span>
                      </span>
                    </div>
                    <div className="rows">
                      {members.map((l) => {
                        const on = !!s[l.key];
                        return (
                          <div key={l.key} className="row shaping-layer">
                            <span className="who">
                              <span className="name">{l.name}</span>
                              <span className="sub">
                                <span data-i18n-skip>{l.stage}</span>
                              </span>
                            </span>
                            <span className="status" data-tone={on ? 'ok' : undefined}>
                              {on ? 'On' : 'Off'}
                            </span>
                            <button
                              type="button"
                              className="button quiet"
                              onClick={() => toggle(l, !on)}
                            >
                              <Icon name={on ? 'i-pause' : 'i-play'} />
                              {on ? 'Turn off' : 'Turn on'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            : null}
        </div>
      </section>

      <section aria-labelledby="h-bytes">
        <div className="screen-head">
          <h2 id="h-bytes">Bytes saved by stage</h2>
          <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
        </div>
        <p>
          Each bar is the stage share of every byte the stack has saved. A stage that grew the body
          says so.
        </p>
        {stats.error && !stats.data ? <Notice {...refusal(stats.status, stats.error)} /> : null}
        {!stats.data && stats.loading ? <p className="skeleton">Reading</p> : null}
        {stats.data && totalSaved === 0 ? (
          <p className="empty">
            No stage has saved a byte yet. Numbers appear after the first request that a layer
            rewrites.
          </p>
        ) : null}
        {stats.data ? (
          <div className="rows">
            {STAGES.map((id) => {
              const st = stageMap[id];
              const grew = st && st.bytesSaved > 0;
              const share = totalSaved > 0 ? saved(st) / totalSaved : 0;
              return (
                <div key={id} className="row shaping-stage">
                  <span className="who">
                    <span className="name" data-i18n-skip>
                      {id}
                    </span>
                  </span>
                  {st ? (
                    <div>
                      <div
                        className="band"
                        data-level={grew ? 'empty' : undefined}
                        aria-hidden="true"
                      >
                        <span className="used" style={{ width: `${share * 100}%` }} />
                      </div>
                      <div className="band-meta">
                        <span data-i18n-skip>{fmtUnit(Math.abs(st.bytesSaved), 'byte')}</span>
                        <span>{grew ? 'Grew' : 'Saved'}</span>
                        <span>{fmtPct(share)}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="unreported">Not reported</span>
                  )}
                  {st ? (
                    <span className="band-meta shaping-counts">
                      <span data-i18n-skip>
                        {fmtNum(st.applied)} / {fmtNum(st.requests)}
                      </span>
                      <span>Applied of seen</span>
                    </span>
                  ) : (
                    <details className="why">
                      <summary>Why</summary>
                      <p>This stage has not run since the ledger began, so it holds no number.</p>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-totals">
        <h2 id="h-totals">What the stack cost and saved</h2>
        <div className="measures tiles">
          <Measure
            big
            label="Requests shaped, all time"
            measure={all ? { value: all.requests } : null}
            render={fmtNum}
          />
          <Measure label="Applied" measure={all ? { value: all.applied } : null} render={fmtNum} />
          <Measure
            label="Bypassed"
            measure={all ? { value: all.bypassed } : null}
            render={fmtNum}
          />
          <Measure
            label="Errored"
            measure={
              all
                ? {
                    value: null,
                    unavailable:
                      'A layer that errors leaves the body untouched and writes no record, so this counter can only ever read zero.',
                  }
                : null
            }
            render={fmtNum}
          />
          <Measure
            label="Characters cut from tool results"
            measure={all ? { value: all.charsReduced } : null}
            render={fmtNum}
          />
          <Measure
            label="Estimated tokens saved"
            measure={all ? { value: all.estTokensSaved } : null}
            render={fmtNum}
          />
          <Measure
            label="Average duration"
            measure={all ? { value: all.avgMs } : null}
            render={(v) => fmtUnit(v, 'millisecond')}
          />
          <Measure
            label="Requests shaped today"
            measure={today ? { value: today.requests } : null}
            render={fmtNum}
          />
          <Measure
            label="Bypassed for a named reason"
            measure={
              all
                ? {
                    value: null,
                    unavailable:
                      'Only one bypass reason is ever written down, so too small to bother, the layer declined and it ran out of time cannot be told apart.',
                  }
                : null
            }
            render={fmtNum}
          />
        </div>
        <p className="caption">
          Units are never mixed. Characters come from the tool result reducer, estimated tokens from
          the compression service.
        </p>
      </section>

      <section aria-labelledby="h-days">
        <h2 id="h-days">Estimated tokens saved per day</h2>
        {!stats.data && stats.loading ? <p className="skeleton">Reading</p> : null}
        {stats.data && timeline.length === 0 ? (
          <p className="empty">
            No day in the last month recorded a compressed request. Days appear once the compression
            service runs.
          </p>
        ) : null}
        {timeline.length ? (
          <div className="rows">
            {timeline.map((d) => (
              <div key={d.date} className="row shaping-day">
                <span className="name" data-i18n-skip>
                  {d.date}
                </span>
                <span data-i18n-skip>{fmtNum(d.tokensSavedEst)}</span>
                <span data-i18n-skip>
                  {fmtNum(d.compressed)} / {fmtNum(d.requests)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-chains">
        <h2 id="h-chains">Model chain overrides</h2>
        {s && chains.length === 0 ? (
          <p className="empty">
            No model chain overrides the stack. A chain that declares nothing runs the layers above.
            Set one under Models.
          </p>
        ) : null}
        {chains.length ? (
          <div className="rows">
            {chains.map((c) => (
              <div key={c.name} className="row shaping-day">
                <span className="name" data-i18n-skip>
                  {c.name}
                </span>
                <span className="sub" data-i18n-skip>
                  {c.keys.join(', ')}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-thresholds">
        <h2 id="h-thresholds">Thresholds</h2>
        <p>
          How large a request must be before a layer bothers, how long an attempt may take, and how
          much history survives. History pruning trades context against cost and is the one setting
          here that can change an answer.
        </p>
        {s ? (
          <div className="panel">
            <div className="shaping-form">
              {THRESHOLDS.map((t) => (
                <label key={t.key} className="field">
                  <span>{t.name}</span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={draft[t.key] ?? s[t.key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.value }))}
                  />
                  {t.unit ? (
                    <span className="caption" data-i18n-skip>
                      {fmtUnit(Number(s[t.key]) || 0, t.unit)}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
            <div className="verb-row">
              <button
                type="button"
                className="button"
                disabled={Object.keys(draft).length === 0}
                onClick={save}
              >
                <Icon name="i-edit" />
                Save
              </button>
              <button
                type="button"
                className="button quiet"
                disabled={Object.keys(draft).length === 0}
                onClick={() => setDraft({})}
              >
                Discard
              </button>
              {Object.keys(draft).length ? (
                <span className="caption">
                  <span data-i18n-skip>{fmtNum(Object.keys(draft).length)}</span>{' '}
                  <span>unsaved</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-service">
        <div className="screen-head">
          <h2 id="h-service">Compression service</h2>
          <Freshness status={pollFresh(status)} lastDataAt={status.goodAt} />
        </div>
        <p>
          Installed, loaded, allowed by policy and healthy are four separate things, and each has
          its own remedy.
        </p>
        {status.error && !status.data ? <Notice {...refusal(status.status, status.error)} /> : null}
        {status.data ? (
          <dl className="facts">
            <dt>Installed</dt>
            <dd>
              <span className="status" data-tone={status.data.installed ? 'ok' : 'warn'}>
                {status.data.installing
                  ? 'Installing'
                  : status.data.installed
                    ? 'Installed'
                    : 'Not installed'}
              </span>
              {status.data.version ? (
                <span className="id" data-i18n-skip>
                  {' '}
                  {status.data.version}
                </span>
              ) : null}
            </dd>
            <dt>Loaded</dt>
            <dd>
              <span className="status" data-tone={status.data.running ? 'ok' : 'warn'}>
                {status.data.running ? 'Loaded' : 'Not loaded'}
              </span>
              {status.data.loadedAt ? (
                <span data-i18n-skip>
                  {' '}
                  {fmtRelative(new Date(status.data.loadedAt).toISOString())}
                </span>
              ) : null}
            </dd>
            <dt>Policy</dt>
            <dd>
              <span className="status" data-tone={status.data.enabled ? 'ok' : 'warn'}>
                {status.data.enabled ? 'Allowed' : 'Switched off'}
              </span>
            </dd>
            <dt>Self-test</dt>
            <dd>
              {health.data ? (
                <span className="status" data-tone={health.data.healthy ? 'ok' : 'bad'}>
                  {health.data.healthy ? 'Passing' : 'Failing'}
                </span>
              ) : health.loading ? (
                <span className="skeleton">Reading</span>
              ) : (
                <span className="unreported">Not reported</span>
              )}
            </dd>
            <dt>Automatic install</dt>
            <dd>{status.data.autoInstall ? 'On' : 'Off'}</dd>
            <dt>npm</dt>
            <dd>{status.data.npmAvailable ? 'Found' : 'Not found'}</dd>
          </dl>
        ) : null}
        {health.data?.checks?.length ? (
          <div className="rows">
            {health.data.checks.map((c) => (
              <div key={c.id} className="row shaping-check">
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {c.label}
                  </span>
                  {c.detail ? (
                    <span className="sub" data-i18n-skip>
                      {c.detail}
                    </span>
                  ) : null}
                </span>
                <span className="status" data-tone={c.ok ? 'ok' : 'bad'}>
                  {c.ok ? 'Passing' : 'Failing'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {health.data && !health.data.healthy && health.data.error ? (
          <Notice
            tone="warn"
            title="The self-test did not pass."
            next="Install again to repair it, or switch the layer off."
            detail={health.data.error}
          />
        ) : null}
        <div className="actions">
          <button type="button" className="button quiet" onClick={() => act('start')}>
            Start
          </button>
          <button type="button" className="button quiet" onClick={() => act('stop')}>
            Stop
          </button>
          <button type="button" className="button quiet" onClick={() => act('restart')}>
            Restart
          </button>
          <button type="button" className="button danger" onClick={() => act('install')}>
            Install
          </button>
          <button type="button" className="link-button" onClick={() => health.refresh()}>
            Check now
          </button>
        </div>
        {px?.recent?.length ? (
          <details className="why">
            <summary>Recent attempts</summary>
            <div className="rows">
              {px.recent.slice(0, 20).map((r, i) => (
                <div key={`${r.ts}-${i}`} className="row shaping-day">
                  <span data-i18n-skip>{fmtRelative(new Date(r.ts).toISOString())}</span>
                  <span>
                    {r.applied ? 'Applied' : 'Bypassed'}
                    {r.reason ? <span data-i18n-skip> {r.reason}</span> : null}
                  </span>
                  <span data-i18n-skip>
                    {fmtNum(r.tokensSavedEst || 0)} {fmtUnit(r.durationMs || 0, 'millisecond')}{' '}
                    {fmtNum(r.imageCount || 0)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {logs.data?.installLog ? (
          <details className="why">
            <summary>Install log</summary>
            <pre className="shaping-log" data-i18n-skip>
              {logs.data.installLog}
            </pre>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="h-tools">
        <h2 id="h-tools">Tool list</h2>
        {disclosure.error && !disclosure.data ? (
          <Notice {...refusal(disclosure.status, disclosure.error)} />
        ) : null}
        {disclosure.data && turns.length === 0 ? (
          <p className="empty">
            No turn has had its tool list shortened. Turns appear once tool list filtering is on and
            a request carries tools.
          </p>
        ) : null}
        {turns.length ? (
          <div className="rows">
            <div className="row head shaping-day">
              <span>Turn</span>
              <span>Disclosed</span>
              <span>Held back</span>
            </div>
            {turns.slice(0, 20).map((t, i) => (
              <div key={`${t.ts}-${i}`} className="row shaping-day">
                <span data-i18n-skip>{fmtRelative(new Date(t.ts).toISOString())}</span>
                <span data-i18n-skip>
                  {fmtNum(t.after)} / {fmtNum(t.before)}
                </span>
                <span data-i18n-skip>{fmtNum(t.stripped)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-open">
        <h2 id="h-open">Fail open</h2>
        <ul className="bullets">
          <li>
            A layer that errors leaves the original body untouched, so it costs savings and never
            correctness.
          </li>
          <li>
            The tool result reducer skips any result marked as an error, so a failure trace survives
            whole.
          </li>
          <li>
            Stopping the compression service leaves new requests uncompressed rather than refused.
          </li>
        </ul>
      </section>

      <Confirm
        open={!!pending}
        title={pending?.title}
        verb={pending?.verb}
        requires={OPERATOR}
        changes={pending?.changes}
        undo={pending?.undo}
        irreversible={pending?.irreversible}
        busy={busy}
        refusal={failed}
        onConfirm={run}
        onClose={close}
      >
        {pending?.layer ? <p className="name">{pending.layer}</p> : null}
      </Confirm>
    </>
  );
}
