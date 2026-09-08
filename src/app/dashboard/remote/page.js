'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { useAuthStatus } from '@/store/authStatus';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtPct, fmtRelative } from '@/shared/format';
import './styles.css';

// The Now screen's derivation, unchanged, so every screen reads one way.
function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// The four states of §17. "Confirmed" differs per transport: the relay confirms
// by having registered its short address, the mesh by having a served address.
function transportState(t) {
  if (!t) return { tone: 'warn', word: 'Unknown' };
  if (!t.settingsEnabled) return { tone: 'warn', word: 'Configured off' };
  if (!t.running) return { tone: 'warn', word: 'Configured on; process not running' };
  return { tone: 'warn', word: 'Running; reachability unverified' };
}

function Probe({ state, at, now }) {
  return (
    <>
      <span className="status" data-tone={state.tone}>
        {state.word}
      </span>
      {at ? (
        <span className="caption">
          {' '}
          Status read <span>{fmtRelative(at, now)}</span>
        </span>
      ) : null}
    </>
  );
}

const LOOPBACK =
  'A request from the machine that runs the gateway. These controls are refused over the relay and the mesh themselves.';
const SESSION = 'An operator session.';
const SWITCH_UNDO = 'Set the switch back. Nothing else changes.';

export default function RemotePage() {
  const tunnel = usePoll('/api/tunnel/status', 10000);
  const mesh = usePoll('/api/tunnel/tailscale-check', 30000);
  const access = usePoll('/api/settings/require-login', 60000);
  const auth = useAuthStatus((s) => s.status);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const relay = tunnel.data?.tunnel;
  const funnel = tunnel.data?.tailscale;
  const download = tunnel.data?.download;
  const host = mesh.data;
  const openSignIn = auth ? auth.requireLogin === false : false;
  const relayState = transportState(relay, !!relay?.publicUrl);
  const meshState = transportState(funnel, !!funnel?.tunnelUrl);
  const dashboardOpen = access.data ? access.data.tunnelDashboardAccess !== false : null;

  const ask = (next) => {
    setFailed(null);
    setDone(null);
    setPending(next);
  };
  const close = () => {
    setPending(null);
    setFailed(null);
    setBusy(false);
  };
  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    const r = await call(pending.url, { method: pending.method, body: pending.body });
    setBusy(false);
    if (!r.ok) {
      setFailed(refusal(r.status, r.body));
      return;
    }
    tunnel.refresh();
    mesh.refresh();
    access.refresh();
    // enable returns HTTP 200 with success:false when the daemon needs a login
    // or the tailnet has not turned Funnel on, so a 2xx is not yet a success.
    if (r.body && r.body.success === false) {
      setFailed({
        tone: 'warn',
        title: 'The gateway did not finish this.',
        next: 'Some setup may have changed before this outcome. Inspect refreshed configuration and process evidence before retrying.',
        detail: r.body.error || r.body.authUrl || r.body.enableUrl,
      });
      return;
    }
    if (pending.url === '/api/settings' || pending.url === '/api/settings/require-login') {
      const readback = await call(pending.url);
      const verified = readback.ok && Object.entries(pending.body || {}).every(([key, value]) => readback.body?.[key] === value);
      if (!verified) {
        setFailed({ tone: 'warn', title: 'The setting was accepted; refreshed state was not verified.', next: 'Close this dialog and refresh before making another change. Do not repeat the mutation.' });
        setBusy(true);
        return;
      }
      setDone({ title: pending.settled });
    } else {
      setDone({ title: 'The process request was accepted. Inspect the refreshed status below; reachability remains unverified.' });
    }
    setPending(null);
    tunnel.refresh();
    mesh.refresh();
    access.refresh();
  };

  return (
    <>
      <div className="screen-head">
        <h1>Remote</h1>
        <Freshness status={pollFresh(tunnel)} lastDataAt={tunnel.goodAt} />
      </div>

      {done ? <Notice tone="ok" title={done.title} /> : null}

      <div className="remote-overview" role="region" aria-label="Remote evidence comparison" tabIndex={0}>
        <table><thead><tr><th>Transport</th><th>Configuration</th><th>Process</th><th>Authentication</th><th>Reachability</th></tr></thead>
          <tbody>{[['Relay', relay, '#h-relay'], ['Mesh', funnel, '#h-mesh']].map(([label, state, target]) => <tr key={label}>
            <th><a href={target}>{label}</a></th><td>{state ? state.settingsEnabled ? 'On' : 'Off' : 'Unknown'}</td>
            <td>{!state ? 'Unknown' : !state.settingsEnabled ? 'Probe skipped while off' : state.running ? 'Running' : 'Not running'}</td>
            <td>{label === 'Mesh' ? host ? host.loggedIn ? 'Joined to tailnet' : 'Not joined to tailnet' : 'Unknown' : 'No separate relay authentication reported'}</td><td>Not reported by status API</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="caption">A stored address and running process do not establish that a remote client can reach the gateway. Sign-in protection and dashboard exposure are separate controls below.</p>

      <section aria-labelledby="h-relay">
        <div className="screen-head">
          <h2 id="h-relay">
            <Icon name="i-remote" />
            Relay
          </h2>
          <Freshness status={pollFresh(tunnel)} lastDataAt={tunnel.goodAt} />
        </div>
        {tunnel.error ? <>
          <Notice {...(tunnel.status === 0 || tunnel.error.code === 'network'
            ? { tone: 'warn', title: 'Remote process status could not be refreshed.', next: tunnel.data ? 'Showing the last successful observation. Current process state is unknown until the next successful read.' : 'Retry this observation. Sign-in policy and mesh host status are read separately.' }
            : refusal(tunnel.status, tunnel.error))} />
          <button type="button" className="button quiet" onClick={tunnel.refresh} disabled={tunnel.loading}>Retry remote process read</button>
        </> : null}
        {tunnel.loading && !tunnel.data ? <p className="skeleton">Reading</p> : null}
        {relay ? (
          <>
            <dl className="facts">
              <dt>Configuration and process</dt>
              <dd>
                <Probe state={relayState} at={tunnel.goodAt} now={now} />
              </dd>
              <dt>Switched on</dt>
              <dd>{relay.settingsEnabled ? <span>On</span> : <span>Off</span>}</dd>
              <dt>Process</dt>
              <dd>
                {!relay.settingsEnabled ? <span className="unreported">Not probed while configured off</span> : relay.running ? (
                  <span className="status" data-tone="ok">
                    Running
                  </span>
                ) : (
                  <span className="status" data-tone="warn">
                    Not running
                  </span>
                )}
              </dd>
              <dt>Public address</dt>
              <dd>
                {relay.publicUrl ? (
                  <span className="id">
                    {relay.publicUrl}
                  </span>
                ) : (
                  <>
                    <span className="unreported">Not reported</span>{' '}
                    <span className="caption">
                      No registered public address is stored. This status read does not test reachability.
                    </span>
                  </>
                )}
              </dd>
              <dt>Direct address</dt>
              <dd>
                {relay.tunnelUrl ? (
                  <span className="id">
                    {relay.tunnelUrl}
                  </span>
                ) : (
                  <span className="unreported">Not reported</span>
                )}
              </dd>
              <dt>Short identifier</dt>
              <dd>
                {relay.shortId ? (
                  <>
                    <span className="id">
                      {relay.shortId}
                    </span>{' '}
                    <span className="caption">
                      Kept when the relay is switched off, so the same public address returns
                    </span>
                  </>
                ) : (
                  <span className="unreported">Not issued yet</span>
                )}
              </dd>
            </dl>
            <p className="caption">A public address is retained from relay registration. Its current reachability and last successful health-check time are not reported by this API.</p>
            {download?.downloading ? (
              <>
                <p className="caption">Downloading the relay program</p>
                <div className="band" aria-hidden="true">
                  <span className="used" style={{ width: `${download.progress}%` }} />
                </div>
                <div className="band-meta">
                  <span>{fmtPct((download.progress || 0) / 100)}</span>
                </div>
              </>
            ) : null}
            {!relay.settingsEnabled && !relay.shortId ? (
              <p className="empty">
                No relay has run on this machine yet. Start the relay to publish a public address.
              </p>
            ) : null}
            {relay.settingsEnabled && !relay.running ? (
              <Notice
                tone="warn"
                title="The switch reads on, but no relay process is running."
                next="Start the relay, or switch it off so the two agree."
              />
            ) : null}
            <div className="panel">
              <h3>Controls</h3>
              <div className="verb-row">
                {relay.running ? (
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      ask({
                        title: 'Stop the relay',
                        verb: 'Stop the relay',
                        url: '/api/tunnel/disable',
                        method: 'POST',
                        requires: LOOPBACK,
                        changes:
                          'The relay process stops and its addresses stop answering. Every remote client on them loses access, including any dashboard session opened through one.',
                        undo: 'Start the relay again. The short identifier is kept, so the same public address returns. The direct address does not, because a fresh one is issued, and any client holding the old one never reaches it again.',
                        settled: 'Relay stopped.',
                        irreversible: true,
                      })
                    }
                  >
                    Stop the relay
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      ask({
                        title: 'Start the relay',
                        verb: 'Start the relay',
                        url: '/api/tunnel/enable',
                        method: 'POST',
                        requires: LOOPBACK,
                        changes:
                          'A relay process starts and publishes a public address. The gateway becomes reachable from the internet there, and the dashboard follows it whenever the setting below allows it. Sign-in is the only thing between that address and this surface.',
                        undo: 'Stop the relay. The address stops answering and the short identifier is kept.',
                        settled: 'Relay started.',
                        warn: true,
                      })
                    }
                  >
                    Start the relay
                  </button>
                )}
                <button
                  type="button"
                  className="button quiet"
                  onClick={() =>
                    ask({
                      title: relay.settingsEnabled ? 'Switch the relay off' : 'Switch the relay on',
                      verb: relay.settingsEnabled ? 'Switch the relay off' : 'Switch the relay on',
                      url: '/api/settings',
                      method: 'PATCH',
                      body: { tunnelEnabled: !relay.settingsEnabled },
                      requires: SESSION,
                      changes: relay.settingsEnabled
                        ? 'The stored switch reads off. A relay process already running keeps running until you stop it.'
                        : 'The stored switch reads on. No process starts, so a relay that is not running stays not running.',
                      undo: SWITCH_UNDO,
                      settled: 'Relay switch saved.',
                    })
                  }
                >
                  {relay.settingsEnabled ? 'Switch the relay off' : 'Switch the relay on'}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-mesh">
        <div className="screen-head">
          <h2 id="h-mesh">
            <Icon name="i-network" />
            Mesh
          </h2>
          <Freshness status={pollFresh(mesh)} lastDataAt={mesh.goodAt} />
        </div>
        {mesh.error ? <>
          <Notice {...(mesh.status === 0 || mesh.error.code === 'network'
            ? { tone: 'warn', title: 'Mesh host status could not be read.', next: mesh.data ? 'Showing the last successful host observation. Current authentication and daemon state remain unverified.' : 'Retry this read. Mesh configuration and process state are reported separately below.' }
            : refusal(mesh.status, mesh.error))} />
          <button type="button" className="button quiet" onClick={mesh.refresh} disabled={mesh.loading}>
            Retry mesh host read
          </button>
        </> : null}
        {mesh.loading && !mesh.data ? <p className="skeleton">Reading</p> : null}
        <dl className="facts">
          <dt>Configuration and process</dt>
          <dd>
            {funnel ? (
              <Probe state={meshState} at={tunnel.goodAt} now={now} />
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Switched on</dt>
          <dd>
            {funnel ? (
              funnel.settingsEnabled ? (
                <span>On</span>
              ) : (
                <span>Off</span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Installed on this machine</dt>
          <dd>
            {host ? (
              host.installed ? (
                <span className="status" data-tone="ok">
                  Installed
                </span>
              ) : (
                <span className="status" data-tone="warn">
                  Not installed
                </span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Daemon</dt>
          <dd>
            {host ? (
              host.daemonRunning ? (
                <span className="status" data-tone="ok">
                  Running
                </span>
              ) : (
                <span className="status" data-tone="warn">
                  Not running
                </span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Joined to your tailnet</dt>
          <dd>
            {host ? (
              host.loggedIn ? (
                <span className="status" data-tone="ok">
                  Joined
                </span>
              ) : (
                <span className="status" data-tone="warn">
                  Not joined
                </span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Mesh address</dt>
          <dd>
            {funnel?.tunnelUrl ? (
              <span className="id">
                {funnel.tunnelUrl}
              </span>
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
          <dt>Stored start-up password</dt>
          <dd>
            {host ? (
              host.hasCachedPassword ? (
                <span>Set</span>
              ) : (
                <span>Not set</span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
            <span className="caption">
              {' '}
              Starting the daemon can need a host password. No route on this screen accepts one, so
              it is set on the machine itself.
            </span>
          </dd>
        </dl>
        <p>
          The mesh serves through Tailscale Funnel, which answers from the internet, not only from
          the devices on your tailnet.
        </p>
        {host && !host.installed ? (
          <p className="empty">
            Tailscale is not installed on this machine. Install it there and join this machine to
            your tailnet, then start the mesh here.
          </p>
        ) : null}
        {funnel?.settingsEnabled && host?.installed && !host.loggedIn ? (
          <Notice
            tone="warn"
            title="The switch reads on, but this machine is not joined to a tailnet."
            next="Start the mesh to begin the join, then follow the address the gateway hands back."
          />
        ) : null}
        <div className="panel">
          <h3>Controls</h3>
          <div className="verb-row">
            {funnel?.running ? (
              <button
                type="button"
                className="button"
                onClick={() =>
                  ask({
                    title: 'Stop the mesh',
                    verb: 'Stop the mesh',
                    url: '/api/tunnel/tailscale-disable',
                    method: 'POST',
                    requires: LOOPBACK,
                    changes:
                      'The funnel stops and the mesh address stops answering. Every remote client on it loses access, including any dashboard session opened through it.',
                    undo: "Start the mesh again. The tailnet keeps this machine's name, so the same address returns.",
                    settled: 'Mesh stopped.',
                  })
                }
              >
                Stop the mesh
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={host ? !host.installed : false}
                onClick={() =>
                  ask({
                    title: 'Start the mesh',
                    verb: 'Start the mesh',
                    url: '/api/tunnel/tailscale-enable',
                    method: 'POST',
                    requires:
                      'A request from the machine that runs the gateway, Tailscale installed there, and Funnel allowed on your tailnet. A join may be asked for first, and it can take a while.',
                    changes:
                      'A Tailscale Funnel starts and serves this gateway at its tailnet address. Funnel answers from the internet, so that address is public, and the dashboard follows it whenever the setting below allows it.',
                    undo: 'Stop the mesh. The address stops answering and this machine stays on your tailnet.',
                    settled: 'Mesh started.',
                    warn: true,
                  })
                }
              >
                Start the mesh
              </button>
            )}
            <button
              type="button"
              className="button quiet"
              disabled={!funnel}
              onClick={() =>
                ask({
                  title: funnel?.settingsEnabled ? 'Switch the mesh off' : 'Switch the mesh on',
                  verb: funnel?.settingsEnabled ? 'Switch the mesh off' : 'Switch the mesh on',
                  url: '/api/settings',
                  method: 'PATCH',
                  body: { tailscaleEnabled: !funnel?.settingsEnabled },
                  requires: SESSION,
                  changes: funnel?.settingsEnabled
                    ? 'The stored switch reads off. A funnel already running keeps running until you stop it.'
                    : 'The stored switch reads on. No funnel starts, so a mesh that is not running stays not running.',
                  undo: SWITCH_UNDO,
                  settled: 'Mesh switch saved.',
                })
              }
            >
              {funnel?.settingsEnabled ? 'Switch the mesh off' : 'Switch the mesh on'}
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-surface">
        <div className="screen-head">
          <h2 id="h-surface">
            <Icon name="i-lock" />
            This surface over those addresses
          </h2>
          <Freshness status={pollFresh(access)} lastDataAt={access.goodAt} />
        </div>
        {access.error ? <>
          <Notice {...(access.status === 0 || access.error.code === 'network'
            ? { tone: 'warn', title: 'Remote access policy could not be refreshed.', next: access.data ? 'The displayed policy is the last successful read. Refresh it before changing remote access.' : 'Policy is unknown. Relay process status does not establish dashboard access policy.' }
            : refusal(access.status, access.error))} />
          <button type="button" className="button quiet" onClick={access.refresh} disabled={access.loading}>Retry access policy read</button>
        </> : null}
        <dl className="facts">
          <dt>Dashboard sign-in</dt>
          <dd>
            {dashboardOpen === null ? (
              <span className="unreported">Not reported</span>
            ) : dashboardOpen ? (
              <span className="status" data-tone="warn">
                Answered over the relay and the mesh
              </span>
            ) : (
              <span className="status" data-tone="ok">
                Refused over the relay and the mesh
              </span>
            )}
          </dd>
          <dt>Sign-in itself</dt>
          <dd>
            {auth ? (
              auth.requireLogin === false ? (
                <span className="status" data-tone="bad">
                  Turned off
                </span>
              ) : (
                <span className="status" data-tone="ok">
                  Required
                </span>
              )
            ) : (
              <span className="unreported">Not reported</span>
            )}
          </dd>
        </dl>
        {openSignIn && dashboardOpen ? (
          <Notice
            tone="bad"
            title="Sign-in is turned off and the dashboard answers over these addresses."
            next="Anyone who reaches an address above reaches this surface with no credential. Turn sign-in back on under Access, or refuse the dashboard here."
          />
        ) : null}
        <p>One switch governs both transports. It cannot allow the relay and refuse the mesh.</p>
        <div className="panel">
          <h3>Controls</h3>
          <div className="verb-row">
            <button
              type="button"
              className="button"
              disabled={dashboardOpen === null}
              onClick={() =>
                ask({
                  title: dashboardOpen
                    ? 'Refuse the dashboard over these addresses'
                    : 'Allow the dashboard over these addresses',
                  verb: dashboardOpen ? 'Refuse the dashboard' : 'Allow the dashboard',
                  url: '/api/settings',
                  method: 'PATCH',
                  body: { tunnelDashboardAccess: !dashboardOpen },
                  requires: SESSION,
                  changes: dashboardOpen
                    ? 'Sign-in over the relay and the mesh is refused. Inference on those addresses keeps answering, because client keys guard it separately.'
                    : 'The dashboard answers sign-in over the relay and the mesh. Anyone who reaches one of those addresses can attempt to sign in.',
                  undo: dashboardOpen
                    ? 'Allow it again. Sessions already open through those addresses were never closed by this.'
                    : 'Refuse it again. Sessions already open through those addresses keep working until they expire.',
                  settled: dashboardOpen
                    ? 'Dashboard refused over these addresses.'
                    : 'Dashboard allowed over these addresses.',
                  warn: !dashboardOpen,
                })
              }
            >
              {dashboardOpen ? 'Refuse the dashboard' : 'Allow the dashboard'}
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="h-reach">
        <h2 id="h-reach">What a remote client reaches</h2>
        <ul className="bullets">
          <li>
            Inference, always, on both addresses. A client API key is what qualifies it, so review
            them under{' '}
            <Link href="/dashboard/keys" prefetch={false}>
              Keys
            </Link>
            .
          </li>
          <li>
            The dashboard, only while the switch above allows it, and only with an operator sign-in.
            Its policy lives under{' '}
            <Link href="/dashboard/access" prefetch={false}>
              Access
            </Link>
            .
          </li>
          <li>
            Nothing that changes state. Those routes answer only a request that arrives on the
            machine itself, or through a transport that ends as a loopback peer.
          </li>
          <li>
            Not these controls. Starting or stopping either transport is refused over that
            transport, so a lost address is recovered at the machine.
          </li>
        </ul>
      </section>

      <section aria-labelledby="remote-host-configuration"><h2 id="remote-host-configuration">Host configuration for remote transports</h2>
        <p>These startup options belong to the gateway service environment. They cannot be changed by saving a dashboard setting. After changing them, restart the gateway through its normal service manager and inspect the transport state above.</p>
        <dl className="facts"><dt>Cloudflare worker service</dt><dd><code>TUNNEL_WORKER_URL=https://your-worker.example</code> selects the registration service and the host used to construct its public address. It must provide the gateway’s worker protocol.</dd>
          <dt>Worker TLS verification</dt><dd><code>TUNNEL_WORKER_INSECURE=1</code> disables certificate verification for that worker host only. Leave this unset when the worker has a trusted certificate.</dd>
          <dt>Tailscale authorization</dt><dd>Set <code>TAILSCALE_AUTHKEY</code> in the gateway’s private service environment to supply the key when Tailscale starts. This page never reads, displays, or stores it. Without it, complete Tailscale’s interactive sign-in.</dd></dl>
        <p>A configured worker URL or auth key is not evidence that the transport runs or that a remote client can reach the gateway. Starting and testing transports remain separate explicit actions.</p>
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <ul className="bullets">
          <li>
            The progress of a mesh installation. The bar above is the relay program downloading, and
            nothing reports an equivalent for the mesh.
          </li>
          <li>
            Whether the operator surface is permitted per transport. One stored switch answers for
            the relay and the mesh together.
          </li>
          <li>
            Cloud sync. A switch and an address are stored, nothing in the gateway reads them, and
            no route reports a last sync, so there is nothing truthful to show.
          </li>
        </ul>
      </section>

      <Confirm
        open={!!pending}
        title={pending?.title}
        verb={pending?.verb}
        requires={pending?.requires}
        changes={pending?.changes}
        undo={pending?.undo}
        irreversible={!!pending?.irreversible}
        busy={busy}
        refusal={failed}
        onConfirm={confirm}
        onClose={close}
      >
        {pending?.warn && openSignIn ? (
          <Notice
            tone="bad"
            title="Sign-in is turned off on this gateway."
            next="Nothing will ask a remote visitor for a credential at that address. Turn sign-in on under Access first."
          />
        ) : null}
      </Confirm>
    </>
  );
}
