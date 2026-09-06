'use client';
import { useState } from 'react';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative } from '@/shared/format';
import './styles.css';

// §18. Three events exist and all three are derived from state the routing
// path already records. The words are §18's own.
const EVENTS = {
  'provider.unhealthy': 'An account became unhealthy',
  'provider.recovered': 'An account recovered',
  'high.error.rate': 'The error rate crossed its threshold',
};
const OPERATOR = 'An operator credential, or a call from the machine that runs the gateway.';
// PUT merges at the top level only, so any write that touches the list sends
// the whole list back, and the read never carries a signing value to send.
const REWRITE =
  'Every stored signing value is cleared, because the gateway never hands one back. Enter each one again.';
const MASK = '•••';

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// A webhook address is itself a credential: userinfo, a long opaque path
// segment and any query are all delivery secrets, so none of them is drawn.
function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.username || u.password ? `${MASK}@${u.host}` : u.host;
    const path = u.pathname
      .split('/')
      .map((s) => (s.length >= 20 ? MASK : s))
      .join('/');
    return `${u.protocol}//${host}${path}${u.search ? `?${MASK}` : ''}`;
  } catch {
    return MASK;
  }
}

const wire = (e) => ({ id: e.id, url: e.url, events: e.events, active: e.active });

function DestinationForm({ endpoint, onCancel, onSubmit }) {
  const [url, setUrl] = useState(endpoint ? endpoint.url : '');
  const [events, setEvents] = useState(() => (endpoint ? endpoint.events : []));
  const [secret, setSecret] = useState('');
  const toggle = (name) =>
    setEvents((es) => (es.includes(name) ? es.filter((e) => e !== name) : [...es, name]));
  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      id: endpoint ? endpoint.id : undefined,
      url: url.trim(),
      events,
      secret,
      active: endpoint ? endpoint.active : true,
    });
    setSecret('');
  };
  return (
    <form className="notifications-form panel" onSubmit={submit}>
      <label className="field">
        <span>Address</span>
        <input
          className="input"
          type="url"
          required
          autoComplete="off"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <fieldset className="notifications-events">
        <legend>Events</legend>
        {Object.entries(EVENTS).map(([id, word]) => (
          <label key={id}>
            <input type="checkbox" checked={events.includes(id)} onChange={() => toggle(id)} />
            <span>{word}</span>
          </label>
        ))}
      </fieldset>
      <p className="caption">Picking no event means every event.</p>
      <label className="field">
        <span>Signing value</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <p className="caption">
        Write-only. It signs every message and is never shown again. Left empty, no signing value is
        stored.
      </p>
      <div className="actions">
        <button type="submit" className="button">
          Save destination
        </button>
        {endpoint ? (
          <button type="button" className="button quiet" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function RateForm({ rate, onSubmit }) {
  const [percent, setPercent] = useState(() => Math.round(rate.threshold * 100));
  const [seconds, setSeconds] = useState(rate.windowSeconds);
  const [samples, setSamples] = useState(rate.minSamples);
  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      threshold: Number(percent) / 100,
      windowSeconds: Number(seconds),
      minSamples: Number(samples),
    });
  };
  return (
    <form className="notifications-form panel" onSubmit={submit}>
      <label className="field">
        <span>Error rate that counts as a problem, in percent</span>
        <input
          className="input"
          type="number"
          min="1"
          max="100"
          step="1"
          required
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Window, in seconds</span>
        <input
          className="input"
          type="number"
          min="60"
          max="86400"
          step="60"
          required
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Fewest requests worth judging on</span>
        <input
          className="input"
          type="number"
          min="1"
          max="100000"
          step="1"
          required
          value={samples}
          onChange={(e) => setSamples(e.target.value)}
        />
      </label>
      <div className="actions">
        <button type="submit" className="button">
          Save rule
        </button>
      </div>
    </form>
  );
}

export default function NotificationsPage() {
  const notif = usePoll('/api/notifications', 15000);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deny, setDeny] = useState(null);
  const [done, setDone] = useState(null);
  const [editing, setEditing] = useState(null);

  const cfg = notif.data?.config;
  const endpoints = cfg?.endpoints || [];
  const deliveries = notif.data?.deliveries || [];
  const held = endpoints.some((e) => e.hasSecret);
  const changes = (base) => (held ? `${base} ${REWRITE}` : base);
  const put = (patch) => () => call('/api/notifications', { method: 'PUT', body: patch });
  const named = (id) => {
    const e = endpoints.find((x) => x.id === id);
    return e ? maskUrl(e.url) : id;
  };

  const confirm = async () => {
    setBusy(true);
    setDeny(null);
    const res = await ask.run();
    setBusy(false);
    if (!res.ok) {
      setDeny(refusal(res.status, res.body));
      return;
    }
    setDone(ask.done ? ask.done(res.body) : null);
    setAsk(null);
    setEditing(null);
    notif.refresh();
  };
  const close = () => {
    setAsk(null);
    setDeny(null);
  };

  const saveDestination = (draft) =>
    setAsk({
      title: draft.id ? 'Change this destination' : 'Add a destination',
      verb: 'Save destination',
      requires: OPERATOR,
      changes: changes('This address receives the events picked for it, as soon as sending is on.'),
      undo: 'Change the destination again, or clear it.',
      run: put({
        endpoints: draft.id
          ? endpoints.map((e) =>
              e.id === draft.id ? { ...wire(draft), secret: draft.secret } : wire(e)
            )
          : [
              ...endpoints.map(wire),
              { url: draft.url, events: draft.events, active: true, secret: draft.secret },
            ],
      }),
      done: () => ({ tone: 'ok', title: 'Destination saved' }),
    });

  return (
    <>
      <div className="screen-head">
        <h1>Notifications</h1>
        <Freshness status={pollFresh(notif)} lastDataAt={notif.goodAt} />
      </div>
      {notif.error && !notif.data ? <Notice {...refusal(notif.status, notif.error)} /> : null}
      {done ? <Notice {...done} /> : null}

      {cfg ? (
        <div className="measures">
          <div className="measure">
            <span className="label">Destinations</span>
            <span className="value" data-i18n-skip>
              {fmtNum(endpoints.length)}
            </span>
          </div>
          <div className="measure">
            <span className="label">Deliveries</span>
            <span className="value" data-i18n-skip>
              {fmtNum(deliveries.length)}
            </span>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="h-sending">
        <h2 id="h-sending">
          <Icon name="i-notifications" />
          Sending
        </h2>
        {notif.loading ? <p className="skeleton">Reading</p> : null}
        {cfg ? (
          <>
            <dl className="facts">
              <dt>Sending</dt>
              <dd>
                <span className="status" data-tone={cfg.enabled ? 'ok' : undefined}>
                  {cfg.enabled ? 'On' : 'Off'}
                </span>
              </dd>
              <dt>Destinations</dt>
              <dd data-i18n-skip>{fmtNum(endpoints.length)}</dd>
            </dl>
            <div className="panel">
              <h3>Controls</h3>
              <div className="verb-row">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    setAsk({
                      title: cfg.enabled ? 'Turn sending off' : 'Turn sending on',
                      verb: cfg.enabled ? 'Turn sending off' : 'Turn sending on',
                      requires: OPERATOR,
                      changes: cfg.enabled
                        ? 'No event is delivered to any destination while sending is off.'
                        : 'Events are delivered to every destination that is on.',
                      undo: cfg.enabled ? 'Turn sending on again.' : 'Turn sending off again.',
                      run: put({ enabled: !cfg.enabled }),
                      done: () => ({
                        tone: 'ok',
                        title: cfg.enabled ? 'Sending is off' : 'Sending is on',
                      }),
                    })
                  }
                >
                  {cfg.enabled ? 'Turn sending off' : 'Turn sending on'}
                </button>
              </div>
            </div>
          </>
        ) : null}
        <h3>Which events fire</h3>
        <ul className="bullets">
          {Object.entries(EVENTS).map(([id, word]) => (
            <li key={id}>{word}</li>
          ))}
        </ul>
        <p className="caption">
          A message goes out when a condition changes, not while it lasts. An account is seeded
          silently the first time it is seen, so a restart does not replay an old incident. A
          destination that does not answer delays no request and fails none.
        </p>
      </section>

      <section aria-labelledby="h-where">
        <h2 id="h-where">
          <Icon name="i-send" />
          Where they go
        </h2>
        {held ? <p className="caption">{REWRITE}</p> : null}
        {cfg && endpoints.length === 0 ? (
          <p className="empty">
            No destination is configured. Add one below; until then nothing is sent anywhere.
          </p>
        ) : null}
        {endpoints.length ? (
          <div className="rows">
            <div className="row head notifications-dest">
              <span>Address</span>
              <span>Events</span>
              <span>Signing value</span>
              <span>Actions</span>
            </div>
            {endpoints.map((e) => (
              <div key={e.id} className="row notifications-dest">
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {maskUrl(e.url)}
                  </span>
                  <span className="sub">
                    <span className="status" data-tone={e.active ? 'ok' : undefined}>
                      {e.active ? 'On' : 'Off'}
                    </span>
                  </span>
                </span>
                <span className="notifications-list">
                  {e.events.length === Object.keys(EVENTS).length ? (
                    <span>Every event</span>
                  ) : (
                    e.events.map((x) => <span key={x}>{EVENTS[x] || x}</span>)
                  )}
                </span>
                <span>{e.hasSecret ? 'Set' : 'Not set'}</span>
                <span className="notifications-actions">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setAsk({
                        title: 'Send a test message',
                        verb: 'Send test',
                        requires: `${OPERATOR} The address must resolve to a public host.`,
                        changes: 'One message is posted to this address now, with no retry.',
                        undo: 'Nothing. A message already sent cannot be recalled.',
                        irreversible: true,
                        run: () =>
                          call('/api/notifications/test', {
                            method: 'POST',
                            body: { endpointId: e.id },
                          }),
                        done: (b) =>
                          b.ok
                            ? { tone: 'ok', title: 'Test sent', detail: `HTTP ${b.status}` }
                            : {
                                tone: 'bad',
                                title: 'The test did not arrive.',
                                next: 'Check the address, and that the receiver answers with a 2xx.',
                                detail: b.error,
                              },
                      })
                    }
                  >
                    Send test
                  </button>
                  <button type="button" className="link-button" onClick={() => setEditing(e.id)}>
                    Change
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setAsk({
                        title: e.active ? 'Turn this destination off' : 'Turn this destination on',
                        verb: e.active ? 'Turn off' : 'Turn on',
                        requires: OPERATOR,
                        changes: changes(
                          e.active
                            ? 'No further event is delivered to this address.'
                            : 'This address receives the events it subscribes to again.'
                        ),
                        undo: e.active ? 'Turn it on again.' : 'Turn it off again.',
                        run: put({
                          endpoints: endpoints.map((x) =>
                            x.id === e.id ? { ...wire(x), active: !x.active } : wire(x)
                          ),
                        }),
                        done: () => ({
                          tone: 'ok',
                          title: e.active ? 'Destination turned off' : 'Destination turned on',
                        }),
                      })
                    }
                  >
                    {e.active ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setAsk({
                        title: 'Clear this destination',
                        verb: 'Clear',
                        requires: OPERATOR,
                        changes: changes(
                          'The address is removed, and no further event is delivered there.'
                        ),
                        undo: 'Nothing. Add the destination again to send there.',
                        irreversible: true,
                        run: put({ endpoints: endpoints.filter((x) => x.id !== e.id).map(wire) }),
                        done: () => ({ tone: 'ok', title: 'Destination cleared' }),
                      })
                    }
                  >
                    Clear
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {editing ? (
          <DestinationForm
            key={editing}
            endpoint={endpoints.find((e) => e.id === editing)}
            onCancel={() => setEditing(null)}
            onSubmit={saveDestination}
          />
        ) : (
          <details>
            <summary>Add a destination</summary>
            <DestinationForm key="new" onSubmit={saveDestination} />
          </details>
        )}
      </section>

      <section aria-labelledby="h-rate">
        <h2 id="h-rate">
          <Icon name="i-alert" />
          When the error rate counts as a problem
        </h2>
        <p className="caption">
          Below the fewest requests worth judging on, the rule does not evaluate at all, so a
          handful of failures is never an alarm.
        </p>
        {cfg ? (
          <RateForm
            key={`${cfg.errorRate.threshold}:${cfg.errorRate.windowSeconds}:${cfg.errorRate.minSamples}`}
            rate={cfg.errorRate}
            onSubmit={(errorRate) =>
              setAsk({
                title: 'Change the error-rate rule',
                verb: 'Save rule',
                requires: OPERATOR,
                changes:
                  'The rule fires at the new rate over the new window, once the new number of requests has been seen.',
                undo: 'Set the previous numbers again.',
                run: put({ errorRate }),
                done: () => ({ tone: 'ok', title: 'Rule saved' }),
              })
            }
          />
        ) : null}
      </section>

      <section aria-labelledby="h-log">
        <h2 id="h-log">The last deliveries</h2>
        {notif.data && deliveries.length === 0 ? (
          <p className="empty">Never sent. A delivery appears here once an event fires.</p>
        ) : null}
        {deliveries.length ? (
          <div className="rows">
            <div className="row head notifications-log">
              <span>Destination</span>
              <span>Event</span>
              <span>Outcome</span>
            </div>
            {deliveries.map((d, i) => (
              <div key={`${d.at}-${i}`} className="row notifications-log">
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {named(d.endpointId)}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {fmtRelative(d.at)}
                  </span>
                </span>
                <span>{EVENTS[d.event] || <span data-i18n-skip>{d.event}</span>}</span>
                <span className="who">
                  <span className="status" data-tone={d.ok ? 'ok' : 'bad'}>
                    {d.ok ? 'Delivered' : 'Not delivered'}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {[
                      d.status ? `HTTP ${d.status}` : null,
                      d.attempts ? `${fmtNum(d.attempts)}x` : null,
                      d.error,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <p className="caption">
          The log holds the last fifty deliveries and lives inside the gateway process, so a restart
          empties it. A test send is not recorded here; its result appears beside the button that
          sent it.
        </p>
      </section>

      <Confirm
        open={Boolean(ask)}
        title={ask?.title}
        verb={ask?.verb}
        requires={ask?.requires}
        changes={ask?.changes}
        undo={ask?.undo}
        irreversible={ask?.irreversible || false}
        busy={busy}
        refusal={deny}
        onConfirm={confirm}
        onClose={close}
      />
    </>
  );
}
