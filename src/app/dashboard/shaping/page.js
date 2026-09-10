'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button, SegmentedControl } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit } from '@/shared/format';
import { useDensity, useLevel } from '@/shared/workspace/Board';
import { ScopeBar } from '@/shared/workspace/ScopeBar';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import shared from '@/shared/workspace/workspace.module.css';
import { ShapingWorkbench } from './Workbench';
import { PlanOverrides } from './PlanOverrides';
import { RuntimeSettings } from './RuntimeSettings';
import { SignedBytes } from './ControlInventory';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { TokenSavings } from './TokenSavings';
import {
  CONTROLS,
  configurationPatch,
  controlLabel,
  controlScope,
  stageEvidence,
} from './controlCatalog';
import './styles.css';

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
      'Drops the currently loaded module. If visual compression is enabled, the next eligible request can load it again. Turn off the global control and any plan override to stop future compression. A transform already in flight finishes on its retained copy.',
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

// One task at a time. The sidebar Everyday / Advanced switch governs the
// controls board; these are separate jobs, not a second level switch.
const TASKS = [
  { value: 'controls', label: 'Controls' },
  { value: 'plans', label: 'Plans' },
  { value: 'profiles', label: 'Profiles' },
  { value: 'services', label: 'Services' },
  { value: 'evidence', label: 'Evidence' },
];
// The shared scope owns the period. Measurements are global aggregates, so the
// account and model filters never narrow them; only the interval does.
const PERIODS = { all: 'all', '24h': 'today', '7d': 'last7d', custom: 'all' };
const PERIOD_LABEL = {
  all: 'retained history',
  today: 'today',
  last7d: 'last 7 days',
  last30d: 'last 30 days',
};
const REASONS = {
  epoch_boundary: 'Stable or unknown cache boundary',
  window_pressure: 'Below context-pressure threshold',
  no_backend: 'No compression sidecar',
  phantom: 'Reported reduction without corresponding body reduction',
};
function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}
const numeric = (value) => (Number.isFinite(value) ? fmtNum(value) : 'Not reported');
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 5000 : 9000 });

function ServiceDetails({ onAction, health, pending }) {
  const status = usePoll('/api/pxpipe/status', 15000);

  return (
    <section className="shaping-service" aria-labelledby="shaping-service-title">
      <div className="shaping-section-head">
        <h2 id="shaping-service-title">Visual compression service</h2>
        <Freshness status={pollFresh(status)} lastDataAt={status.goodAt} />
        <Button size="xs" variant="subtle" onClick={status.refresh}>
          Refresh status
        </Button>
      </div>
      <p>
        PXPIPE runs inside the gateway process. Reading status does not install, load or test the
        module.
      </p>
      {status.error ? <Notice {...refusal(status.status, status.error)} /> : null}
      <dl className="shaping-service-facts">
        <div>
          <dt>Installed</dt>
          <dd>
            {!status.data
              ? 'Not reported'
              : status.data.installing
                ? 'Installing'
                : status.data.installed
                  ? 'Installed'
                  : 'Not installed'}
            {status.data?.version ? <code>{status.data.version}</code> : null}
          </dd>
        </div>
        <div>
          <dt>Loaded</dt>
          <dd>{!status.data ? 'Not reported' : status.data.running ? 'Loaded' : 'Not loaded'}</dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>
            {!status.data ? 'Not reported' : status.data.enabled ? 'Allowed' : 'Switched off'}
          </dd>
        </div>
        <div>
          <dt>Local self-test</dt>
          <dd>{health ? (health.healthy ? 'Passing' : 'Failing') : 'Not run in this view'}</dd>
        </div>
        <div>
          <dt>Automatic install</dt>
          <dd>{!status.data ? 'Not reported' : status.data.autoInstall ? 'On' : 'Off'}</dd>
        </div>
        <div>
          <dt>Package manager</dt>
          <dd>
            {!status.data ? 'Not reported' : status.data.npmAvailable ? 'Available' : 'Not found'}
          </dd>
        </div>
      </dl>
      <div className="shaping-actions">
        {Object.keys(SERVICE).map((id) => (
          <Button
            key={id}
            size="xs"
            variant={id === 'install' ? 'light' : 'default'}
            color={id === 'install' ? 'red' : undefined}
            onClick={() => onAction({ ...SERVICE[id], url: `/api/pxpipe/${id}` })}
          >
            {SERVICE[id].verb}
          </Button>
        ))}
        <Button
          size="xs"
          variant="default"
          onClick={() =>
            onAction({
              title: 'Run the local compression check',
              verb: 'Run local check',
              changes:
                'Loads the installed PXPIPE module and transforms synthetic local input. This can change the loaded state. It does not call a model provider.',
              undo: 'Stop the module here if it should remain unloaded.',
              url: '/api/pxpipe/health',
              health: true,
              done: 'Local check finished.',
            })
          }
        >
          Run local check
        </Button>
      </div>
      {pending}
      {health?.checks?.length ? (
        <ul className="shaping-observations">
          {health.checks.map((check) => (
            <li key={check.id}>
              <span>{check.label}</span>
              <span>{check.ok ? 'Passing' : 'Failing'}</span>
              {check.detail ? <span>{check.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {health && !health.healthy ? (
        <Notice tone="warn" title="The local self-test did not pass." detail={health.error} />
      ) : null}
      <p className="shaping-caption">
        A retained installation-log endpoint is not available in this gateway.
      </p>
    </section>
  );
}

function RecordedEvidence({ stats, period }) {
  const window = stats.data?.windows?.[period];
  const stageMap = window?.stages || {};
  const stages = [...new Set(CONTROLS.map((control) => control.stage).filter(Boolean))];
  const timeline = (stats.data?.pxpipe?.timeline || []).filter((day) => day.requests > 0);
  const disclosure = usePoll('/api/tool-disclosure/stats', 30000);
  const turns = Array.isArray(disclosure.data) ? disclosure.data : [];
  return (
    <section className="shaping-recorded" aria-labelledby="shaping-recorded-title">
      <div className="shaping-section-head">
        <h2 id="shaping-recorded-title">Recorded stage evidence</h2>
        <span className="shaping-caption">
          Period follows the shared scope · {PERIOD_LABEL[period]}
        </span>
        <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
      </div>
      <p>
        Global aggregate events, unfiltered by account or model. One request can produce several
        stage records. Negative bytes mean reduction; positive bytes mean growth.
      </p>
      <div className="shaping-integrity-note">
        Byte coverage is shown per stage. A record without a byte measurement contributes no
        measurement; a measured zero remains zero. Stage deltas are not added into a pipeline total,
        token saving or cost saving.
      </div>
      {stats.error ? <Notice {...refusal(stats.status, stats.error)} /> : null}
      {stats.data && !Object.keys(stageMap).length ? (
        <p className="shaping-empty">
          No stage records in this period. Evidence appears when an eligible request records a stage
          outcome.
        </p>
      ) : null}
      <div className="shaping-table-scroll">
        <table className="shaping-evidence-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Recorded delta</th>
              <th>Applied records</th>
              <th>Byte coverage</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => {
              const evidence = stageEvidence(stageMap, stage);
              const name = CONTROLS.find((control) => control.stage === stage)?.name;
              return (
                <tr key={stage}>
                  <th>
                    {name}
                    <code>{stage}</code>
                  </th>
                  <td>
                    {!evidence.measured ? (
                      <span className="unreported">
                        {evidence.measuredRecords === 0 ? 'Not measured' : 'Not reported'}
                      </span>
                    ) : (
                      <SignedBytes value={evidence.delta} />
                    )}
                  </td>
                  <td>{numeric(evidence.applied)}</td>
                  <td>
                    {evidence.measuredRecords === null ? (
                      'Unknown'
                    ) : (
                      <>
                        <bdi dir="ltr">
                          {numeric(evidence.measuredRecords)} / {numeric(evidence.records)}
                        </bdi>{' '}
                        records
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="shaping-technical">
        <summary>Separate units and reporting limits</summary>
        <dl className="shaping-service-facts">
          <div>
            <dt>Tool result characters removed</dt>
            <dd>{numeric(window?.charsReduced)}</dd>
          </div>
          <div>
            <dt>Headroom reported token reduction</dt>
            <dd>{numeric(window?.proxyTokensSaved)}</dd>
          </div>
          <div>
            <dt>PXPIPE estimated token reduction</dt>
            <dd>{numeric(window?.estTokensSaved)}</dd>
          </div>
          <div>
            <dt>Recorded transform duration, mean</dt>
            <dd>
              {Number.isFinite(window?.avgMs)
                ? fmtUnit(window.avgMs, 'millisecond')
                : 'Not reported'}
            </dd>
          </div>
          <div>
            <dt>Errors</dt>
            <dd>Not reported</dd>
          </div>
        </dl>
        <p>
          Errors can bypass the event sink, so zero errors would not establish successful execution.
          Character counts, reported tokens, token estimates and serialized bytes describe different
          quantities.
        </p>
      </details>
      <details className="shaping-technical">
        <summary>Compression estimates by day</summary>
        <p>
          PXPIPE only, from its retained daily records. Estimates do not establish billed token or
          cost reductions.
        </p>
        {timeline.length ? (
          <div className="shaping-table-scroll">
            <table className="shaping-evidence-table">
              <thead>
                <tr>
                  <th>UTC date</th>
                  <th>Estimated token reduction</th>
                  <th>Compressed / recorded</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((day) => (
                  <tr key={day.date}>
                    <th>{day.date}</th>
                    <td>{numeric(day.tokensSavedEst)}</td>
                    <td>
                      {numeric(day.compressed)} / {numeric(day.requests)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No compressed request is recorded in the returned daily history.</p>
        )}
      </details>
      <details className="shaping-technical">
        <summary>Recent compression attempts</summary>
        {stats.data?.pxpipe?.recent?.length ? (
          <ul className="shaping-observations">
            {stats.data.pxpipe.recent.slice(0, 20).map((row, index) => (
              <li key={`${row.ts}-${index}`}>
                <span>{fmtRelative(new Date(row.ts).toISOString())}</span>
                <span>
                  {row.applied ? 'Applied' : 'Bypassed'}
                  {row.reason ? ` (${REASONS[row.reason] || row.reason})` : ''}
                </span>
                <span>{numeric(row.tokensSavedEst)} estimated tokens</span>
                <span>{numeric(row.durationMs)} ms</span>
                <span>{numeric(row.imageCount)} images</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent compression attempt is available in this sample.</p>
        )}
      </details>
      <details className="shaping-technical">
        <summary>Tool disclosure records</summary>
        {disclosure.error ? <Notice {...refusal(disclosure.status, disclosure.error)} /> : null}
        {turns.length ? (
          <div className="shaping-table-scroll">
            <table className="shaping-evidence-table">
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>Disclosed / original tools</th>
                  <th>Held back</th>
                </tr>
              </thead>
              <tbody>
                {turns.slice(0, 20).map((turn, index) => (
                  <tr key={`${turn.ts}-${index}`}>
                    <th>{fmtRelative(new Date(turn.ts).toISOString())}</th>
                    <td>
                      {numeric(turn.after)} / {numeric(turn.before)}
                    </td>
                    <td>{numeric(turn.stripped)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No disclosure record is available in this sample.</p>
        )}
      </details>
    </section>
  );
}

export default function ShapingPage() {
  const { scope } = useWorkspace();
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const period = PERIODS[scope.period] || 'all';
  const settings = usePoll('/api/settings', 30000);
  const controls = usePoll('/api/admin/shaping', 30000);
  const stats = usePoll('/api/token-saver/stats?timelineDays=30&recentLimit=100', 15000);
  const [task, setTask] = useState('controls');
  const [opened, setOpened] = useState(['controls']);
  const [pending, setPending] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [health, setHealth] = useState(null);
  const [serviceRevision, setServiceRevision] = useState(0);
  const s = controls.data?.settings ? { ...settings.data, ...controls.data.settings } : null;
  const chains = Object.entries(s?.comboStrategies || {})
    .filter(([, value]) => value && Object.hasOwn(value, 'tokenSaver'))
    .map(([name, value]) => ({ name, value: value.tokenSaver }));

  function navigate(next) {
    setTask(next);
    setOpened((previous) => (previous.includes(next) ? previous : [...previous, next]));
  }
  function close() {
    if (!busy) {
      setPending(null);
      setFailed(null);
      setConsent(false);
    }
  }

  // Saves the exact patch through the retained-hash boundary, then reads the
  // settings back and reports whether the exact value was confirmed.
  async function writeSettings(patch, label) {
    if (busy) return false;
    const expectedCurrent = controls.data?.currentHash;
    const before = controls.data?.settings;
    if (!expectedCurrent) {
      toast('orange', 'Saved controls have not been read yet, so nothing was sent.', label);
      return false;
    }
    setBusy(true);
    setFailed(null);
    const after = { ...before, ...patch };
    const response = await call('/api/admin/shaping/controls', {
      method: 'POST',
      body: {
        patch,
        expectedCurrent,
        consent: Object.keys(after).filter((key) => after[key] === true),
      },
    });
    if (!response.ok) {
      setFailed(
        response.body?.code === 'settings_conflict'
          ? {
              tone: 'warn',
              title: 'Settings changed after this view was read.',
              children: 'Refresh controls and review the change again.',
            }
          : refusal(response.status, response.body)
      );
      setBusy(false);
      if (!pending) toast('orange', response.body?.error || `Refused (${response.status})`, label);
      return false;
    }
    const verification = await call('/api/admin/shaping');
    const verified =
      response.status !== 207 &&
      verification.ok &&
      verification.body?.currentHash === response.body?.afterHash &&
      Object.entries(patch).every(
        ([key, value]) =>
          JSON.stringify(verification.body?.settings?.[key]) === JSON.stringify(value)
      );
    settings.refresh();
    controls.refresh();
    setBusy(false);
    setPending(null);
    setConsent(false);
    toast(
      verified ? 'teal' : 'orange',
      verified
        ? `${label} saved and verified after refresh.`
        : 'Save accepted; refreshed settings could not be confirmed. Refresh and inspect the control before another change.',
      label
    );
    return verified;
  }

  // Turning a control on grants a new content-changing transformation, so it
  // asks for consent in place. Turning one off removes a transformation and
  // saves directly, as a threshold or a level does.
  function toggle(control, on) {
    setFailed(null);
    setConsent(false);
    if (!on) {
      void writeSettings({ [control.key]: false }, control.name);
      return;
    }
    setPending({
      control,
      group: control.group,
      title: `Turn on ${control.name.toLowerCase()}`,
      verb: 'Turn on',
      changes: `${controlScope(control)}. New requests take this setting; a request already in flight retains its settings. ${control.effect}`,
      undo: 'Restore the previous setting here. Already removed request content cannot be recovered by changing this setting.',
      patch: { [control.key]: true },
    });
  }
  function field(key, raw) {
    const patch = configurationPatch({ [key]: raw });
    if (!patch) {
      toast(
        'orange',
        'Use a whole number within the field limits, a listed level, or at most 100 entries of 500 characters. Nothing was sent.',
        controlLabel(key)
      );
      return;
    }
    void writeSettings(patch, controlLabel(key));
  }
  async function runAction() {
    const action = pending;
    if (!action || busy) return;
    if (action.patch && !consent) {
      setFailed({
        tone: 'warn',
        title: 'Review and consent to the enabled content-changing controls before saving.',
      });
      return;
    }
    if (action.patch) {
      await writeSettings(action.patch, action.control.name);
      return;
    }
    setBusy(true);
    setFailed(null);
    setHealth(null);
    const response = await call(action.url, { method: 'POST' });
    const observedHealth = action.health ? response.body : response.body?.health;
    if (observedHealth && typeof observedHealth.healthy === 'boolean') {
      setHealth(observedHealth);
      setServiceRevision((value) => value + 1);
    }
    if (!response.ok) {
      setFailed(refusal(response.status, response.body));
      setBusy(false);
      return;
    }
    toast(
      observedHealth?.healthy === false ? 'orange' : 'teal',
      observedHealth?.healthy === false
        ? `Operation finished, but the local self-test failed. ${observedHealth.error || ''}`
        : action.done,
      action.title
    );
    setServiceRevision((value) => value + 1);
    setPending(null);
    setBusy(false);
  }
  const confirm = {
    busy,
    refusal: failed,
    consent,
    onConsent: pending?.patch ? setConsent : undefined,
    onConfirm: runAction,
    onCancel: close,
  };

  return (
    <div className={`${shared.lensPage} shaping-page`} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Token savings</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · every saver, its saved state and what it measured
          </p>
        </div>
        <SegmentedControl
        size="xs"
        aria-label="Token savings task"
        value={task}
        onChange={navigate}
        data={TASKS}
        className="shaping-tasks"
      />
    </div>
      <ScopeBar analysisActions={false} showRefresh={false} />
      <div className={`${shared.lensBody} shaping-body`}>
        {settings.error ? <Notice {...refusal(settings.status, settings.error)} /> : null}
        {controls.error ? <Notice {...refusal(controls.status, controls.error)} /> : null}
        {stats.error && task !== 'controls' ? (
          <Notice {...refusal(stats.status, stats.error)} />
        ) : null}
        {task === 'controls' ? (
          <TokenSavings
            advanced={advanced}
            density={density}
            onDensity={setDensity}
            settings={s}
            stageMap={stats.data?.windows?.[period]?.stages || {}}
            recent={stats.data?.recent || []}
            onToggle={toggle}
            onField={field}
            onNavigate={navigate}
            onRefresh={() => {
              settings.refresh();
              controls.refresh();
              stats.refresh();
            }}
            loading={controls.loading}
            unavailable={!!stats.error}
            busy={busy}
            pending={pending}
            confirm={confirm}
            periodNote={
          <span className="shaping-header-observations">
            <span>Measured over {PERIOD_LABEL[period]}</span>
            <span>
              <span className="shaping-caption">Settings</span>
              <Freshness status={pollFresh(controls)} lastDataAt={controls.goodAt} />
            </span>
            <span>
              <span className="shaping-caption">Records</span>
              <Freshness status={pollFresh(stats)} lastDataAt={stats.goodAt} />
            </span>
          </span>
        }
      />
        ) : null}
        {task === 'controls' && advanced ? (
          <details className="shaping-technical shaping-scope">
            <summary>Routing precedence and context-window policy</summary>
            <p>
              Global settings are the baseline. The outermost routing-plan declaration wins;
              unspecified supported flags inherit global values. A plan can disable its 15 supported
              override flags; an explicit per-stage value wins over that plan gate. Privacy,
              disclosure, memory controls, content-change permissions and adaptive cache lifetime
              remain global.
            </p>
            {chains.length ? (
              <ul className="shaping-observations">
                {chains.map((chain) => (
                  <li key={chain.name}>
                    <code>{chain.name}</code>
                    <code>{JSON.stringify(chain.value)}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No routing-plan shaping override is configured.</p>
            )}
            <p>
              Context-window overrides and cascade routing have separate settings and are outside
              shaping profiles.
            </p>
            <div className="shaping-next">
              <Link href="/dashboard/models">Open model and plan settings</Link>
              <Link href="/dashboard/model-context">Edit context-window overrides</Link>
            </div>
          </details>
        ) : null}
        {task === 'plans' && opened.includes('plans') ? (
          <PlanOverrides
            globalSettings={controls.data?.settings}
            onSettingsChanged={() => {
              settings.refresh();
              controls.refresh();
            }}
          />
        ) : null}
        {task === 'profiles' && opened.includes('profiles') ? (
          <ShapingWorkbench
            onSettingsChanged={() => {
              settings.refresh();
              controls.refresh();
            }}
          />
        ) : null}
        {task === 'services' && opened.includes('services') ? (
          <>
            <RuntimeSettings />
            <ServiceDetails
              key={serviceRevision}
              onAction={(action) => {
                setFailed(null);
                setConsent(false);
                setPending(action);
              }}
              health={health}
              pending={
                pending && !pending.patch ? <InlineConfirm {...pending} {...confirm} /> : null
              }
            />
          </>
        ) : null}
        {task === 'evidence' && opened.includes('evidence') ? (
          <RecordedEvidence stats={stats} period={period} />
        ) : null}
      </div>
    </div>
  );
}
