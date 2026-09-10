'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ActionIcon, Button, Loader, Text, TextInput, Tooltip } from '@mantine/core';
import { usePoll } from '@/shared/hooks/usePoll';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative } from '@/shared/format';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import { NotificationRules } from '@/shared/workspace/NotificationRules';
import board from '@/shared/workspace/board.module.css';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './notifications.module.css';

const EVENTS = {
  'provider.unhealthy': 'An account became unhealthy',
  'provider.recovered': 'An account recovered',
  'high.error.rate': 'The error rate crossed its threshold',
  'rule.fired': 'A configured rule produced an alert',
  'project.budget.alert': 'A project reached its recorded budget threshold',
};
const OPERATOR = 'An operator credential, or a call from the machine that runs the gateway.';
// PUT merges at the top level only, so any write that touches the list sends
// the whole list back, and the read never carries a signing value to send.
const REWRITE =
  'Every stored signing value is cleared, because the gateway never hands one back. Enter each one again.';
const MASK = '•••';
const DELIVERY_WORD = {
  queued: 'Queued',
  delivering: 'Sending',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Unconfirmed',
};

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

// The inline add or change row for one destination. Editing an existing
// destination prefills the address and events; the signing value never does,
// because the gateway never hands one back.
function DestinationRow({ endpoint, busy, onCancel, onSubmit, onTest }) {
  const [url, setUrl] = useState(endpoint ? endpoint.url : '');
  const [events, setEvents] = useState(() => (endpoint ? endpoint.events : []));
  const [secret, setSecret] = useState('');
  const toggle = (name) =>
    setEvents((current) => (current.includes(name) ? current.filter((e) => e !== name) : [...current, name]));
  return (
    <form
      className={board.addRow}
      aria-label={endpoint ? `Change ${maskUrl(endpoint.url)}` : 'Add a destination'}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          id: endpoint ? endpoint.id : undefined,
          url: url.trim(),
          events,
          secret,
          active: endpoint ? endpoint.active : true,
        });
        setSecret('');
      }}
    >
      <TextInput
        size="xs"
        type="url"
        required
        autoComplete="off"
        aria-label="Address"
        placeholder="https://hooks.example.com/…"
        className={styles.addUrl}
        value={url}
        onChange={(event) => setUrl(event.currentTarget.value)}
      />
      <TextInput
        size="xs"
        type="password"
        autoComplete="off"
        aria-label="Signing value"
        placeholder="Signing value"
        className={styles.addSecret}
        value={secret}
        onChange={(event) => setSecret(event.currentTarget.value)}
      />
      <span className={styles.events} role="group" aria-label="Events">
        {Object.entries(EVENTS).map(([id, word]) => (
          <button
            key={id}
            type="button"
            className={board.fleetChip}
            aria-pressed={events.includes(id)}
            onClick={() => toggle(id)}
          >
            {word}
          </button>
        ))}
      </span>
      <Button type="submit" size="xs" loading={busy}>
        Save destination
      </Button>
      <Button
        type="button"
        size="xs"
        variant="default"
        onClick={(event) => {
          if (!event.currentTarget.form.reportValidity()) return;
          onTest({ url: url.trim(), secret });
          setSecret('');
        }}
      >
        Test this address without saving
      </Button>
      {endpoint ? (
        <Button type="button" size="xs" variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      <span className={board.addNote}>
        Picking no event means every event. The signing value is write-only: it signs every message,
        is never shown again, and leaving it empty stores none.
      </span>
    </form>
  );
}

export default function NotificationsPage() {
  return (
    <Suspense fallback={<p>Loading notification workspace…</p>}>
      <NotificationsContent />
    </Suspense>
  );
}

function NotificationsContent() {
  const eventId = useSearchParams().get('event');
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const notif = usePoll('/api/notifications', 15000);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deny, setDeny] = useState(null);
  const [done, setDone] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);

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
  const match = (text) => !query.trim() || String(text).toLowerCase().includes(query.trim().toLowerCase());

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
  const cancel = () => {
    setAsk(null);
    setDeny(null);
  };
  const askFor = (key, value) => {
    setDeny(null);
    setDone(null);
    setAsk({ key, ...value });
  };

  const saveDestination = (draft) =>
    askFor(draft.id ? `save:${draft.id}` : 'save:new', {
      title: draft.id ? 'Change this destination' : 'Add a destination',
      verb: 'Save destination',
      requires: OPERATOR,
      changes: changes('This address receives the events picked for it, as soon as sending is on.'),
      undo: 'Change the destination again, or clear it.',
      run: put({
        endpoints: draft.id
          ? endpoints.map((e) => (e.id === draft.id ? { ...wire(draft), secret: draft.secret } : wire(e)))
          : [
              ...endpoints.map(wire),
              { url: draft.url, events: draft.events, active: true, secret: draft.secret },
            ],
      }),
      done: () => ({ tone: 'ok', title: 'Destination saved' }),
    });

  const testDraft = (draft) =>
    askFor('test:new', {
      title: 'Test this address without saving',
      verb: 'Send test',
      requires: `${OPERATOR} The address must resolve to a public host.`,
      changes:
        'Posts one test message to the entered address, using the entered signing value. No destination is saved. This direct test is not retained in the delivery history.',
      undo: 'A sent message cannot be recalled.',
      irreversible: true,
      run: () => call('/api/notifications/test', { method: 'POST', body: draft }),
      done: (body) => ({
        tone: body.ok ? 'ok' : 'warn',
        title: body.ok ? 'Test response received' : 'Test delivery was not confirmed',
        detail: body.ok ? `HTTP ${body.status}` : body.error,
        next: 'No destination was saved. The test used one attempt and was not added to the process delivery list.',
      }),
    });

  const failed = deliveries.filter((d) => !d.ok).length;
  const active = endpoints.filter((e) => e.active).length;
  const chips = [
    { id: null, label: 'destinations', count: endpoints.length },
    { id: 'on', tone: 'positive', label: 'on', count: active },
    { id: 'off', label: 'off', count: endpoints.length - active },
    { id: 'failed', tone: 'refusal', label: 'failed deliveries', count: failed },
  ];
  // A chip narrows the board to its own bucket: the two destination chips hide
  // the deliveries, and the failed chip hides the destinations.
  const showEndpoints = bucket !== 'failed';
  const showDeliveries = bucket === null || bucket === 'failed';
  const visibleEndpoints = endpoints.filter(
    (e) => showEndpoints && (!bucket || (bucket === 'on') === Boolean(e.active)) && match(maskUrl(e.url))
  );
  const visibleDeliveries = deliveries.filter(
    (d) =>
      showDeliveries &&
      (bucket !== 'failed' || !d.ok) &&
      match(`${named(d.endpointId)} ${EVENTS[d.event] || d.event}`)
  );

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Notifications</h1>
          <p>{advanced ? 'Advanced' : 'Everyday'} · what raises an alert, where it goes and what arrived</p>
        </div>
        <Freshness status={pollFresh(notif)} lastDataAt={notif.goodAt} />
      </div>

      <div className={`${shared.lensBody} ${styles.stack}`}>
        {notif.error && !notif.data ? (
          <Text size="xs" c="orange.8" role="alert" className={styles.pageNotice}>
            {refusal(notif.status, notif.error).title} {refusal(notif.status, notif.error).next}
          </Text>
        ) : null}
        {done ? (
          <Text size="xs" role="status" className={styles.pageNotice} data-tone={done.tone}>
            <strong>{done.title}</strong> {done.detail} {done.next}
          </Text>
        ) : null}

        <NotificationRules
          selectedEventId={eventId}
          advanced={advanced}
          density={density}
          onDensity={setDensity}
        />

        <Board label="Notification delivery" advanced={advanced} density={density}>
          <BoardSummary
            label="Delivery summary"
            chips={chips}
            active={bucket}
            onPick={(id) => setBucket(id === bucket ? null : id)}
            note={
              notif.loading && !cfg
                ? 'Reading destinations…'
                : `${fmtNum(deliveries.length)} retained ${deliveries.length === 1 ? 'delivery' : 'deliveries'}`
            }
          />
          <BoardToolbar
            search={query}
            onSearch={setQuery}
            searchLabel="Search destinations and deliveries"
            actions={
              <>
                <Button
                  size="xs"
                  leftSection={<Icon name="i-add" />}
                  aria-expanded={adding}
                  onClick={() => {
                    setEditing(null);
                    setAdding((previous) => !previous);
                  }}
                >
                  Add destination
                </Button>
                <Tooltip label="Re-read destinations and deliveries">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh destinations"
                    loading={notif.loading}
                    onClick={notif.refresh}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          />

          {adding || (cfg && !endpoints.length) ? (
            <DestinationRow busy={busy} onSubmit={saveDestination} onTest={testDraft} />
          ) : null}
          {ask?.key === 'save:new' || ask?.key === 'test:new' ? (
            <div className={board.notice}>
              <InlineConfirm {...ask} busy={busy} refusal={deny} onConfirm={confirm} onCancel={cancel} />
            </div>
          ) : null}

          <BoardGroup label="Sending" count={1}>
            <Card
              id="sending"
              label="Sending"
              head={
                <>
                  <span className={styles.mark} aria-hidden="true">
                    <Icon name="i-notifications" />
                  </span>
                  <div className={board.identityText}>
                    <strong>Sending</strong>
                    <small>A message goes out when a condition changes, not while it lasts</small>
                  </div>
                </>
              }
              state={
                cfg ? (
                  <>
                    <StateWord tone={cfg.enabled ? 'positive' : null}>{cfg.enabled ? 'On' : 'Off'}</StateWord>
                    <span className={board.spacer} />
                    <span className={board.cardAttempts}>
                      {fmtNum(endpoints.length)} {endpoints.length === 1 ? 'destination' : 'destinations'}
                    </span>
                  </>
                ) : null
              }
            >
              {held ? <p className={styles.note}>{REWRITE}</p> : null}
              <span className={styles.cardActions}>
                <Button
                  size="compact-xs"
                  variant="default"
                  disabled={!cfg}
                  onClick={() =>
                    askFor('evaluate', {
                      title: 'Evaluate webhook conditions now',
                      verb: 'Evaluate now',
                      requires: OPERATOR,
                      changes:
                        'Reads recorded provider state and error-rate evidence now. Changed conditions may send real messages to enabled destinations. This does not probe providers or evaluate retained-evidence rules.',
                      undo: 'Messages already sent cannot be recalled.',
                      irreversible: true,
                      run: () => call('/api/notifications', { method: 'POST' }),
                      done: () => ({
                        tone: 'ok',
                        title: 'Webhook conditions evaluated',
                        next: 'Inspect delivery outcomes below. Evaluation does not establish that every destination received a message.',
                      }),
                    })
                  }
                >
                  Evaluate webhook conditions now
                </Button>
                <Button
                  size="compact-xs"
                  disabled={!cfg}
                  onClick={() =>
                    askFor('sending', {
                      title: cfg.enabled ? 'Turn sending off' : 'Turn sending on',
                      verb: cfg.enabled ? 'Turn sending off' : 'Turn sending on',
                      requires: OPERATOR,
                      changes: cfg.enabled
                        ? 'No event is delivered to any destination while sending is off.'
                        : 'Events are delivered to every destination that is on.',
                      undo: cfg.enabled ? 'Turn sending on again.' : 'Turn sending off again.',
                      run: put({ enabled: !cfg.enabled }),
                      done: () => ({ tone: 'ok', title: cfg.enabled ? 'Sending is off' : 'Sending is on' }),
                    })
                  }
                >
                  {cfg?.enabled ? 'Turn sending off' : 'Turn sending on'}
                </Button>
              </span>
              {ask?.key === 'evaluate' || ask?.key === 'sending' ? (
                <InlineConfirm {...ask} busy={busy} refusal={deny} onConfirm={confirm} onCancel={cancel} />
              ) : null}
            </Card>
          </BoardGroup>

          {visibleEndpoints.length ? (
            <BoardGroup label="Destinations" count={visibleEndpoints.length}>
              {visibleEndpoints.map((e) => {
                const name = maskUrl(e.url);
                if (editing === e.id)
                  return (
                    <DestinationRow
                      key={e.id}
                      endpoint={e}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSubmit={saveDestination}
                      onTest={testDraft}
                    />
                  );
                return (
                  <Card
                    key={e.id}
                    id={e.id}
                    label={name}
                    head={
                      <>
                        <span className={styles.mark} aria-hidden="true">
                          <Icon name="i-connections" />
                        </span>
                        <div className={board.identityText}>
                          <span className={styles.name}>
                            {name}
                          </span>
                          <small>
                            {e.events.length === Object.keys(EVENTS).length
                              ? 'Every event'
                              : e.events.map((x) => EVENTS[x] || x).join(' · ') || 'Every event'}
                          </small>
                        </div>
                        <Tooltip label={e.active ? 'Turn this destination off' : 'Turn this destination on'}>
                          <ActionIcon
                            variant={e.active ? 'subtle' : 'light'}
                            color={e.active ? 'gray' : 'teal'}
                            aria-label={`${e.active ? 'Turn off' : 'Turn on'} ${name}`}
                            aria-pressed={!e.active}
                            onClick={() =>
                              askFor(`active:${e.id}`, {
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
                            <Icon name={e.active ? 'i-pause' : 'i-play'} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Change this destination">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label={`Change ${name}`}
                            onClick={() => {
                              setAdding(false);
                              setEditing(e.id);
                            }}
                          >
                            <Icon name="i-edit" />
                          </ActionIcon>
                        </Tooltip>
                      </>
                    }
                    state={
                      <>
                        <StateWord tone={e.active ? 'positive' : null}>{e.active ? 'On' : 'Off'}</StateWord>
                        <span className={board.spacer} />
                        <span className={board.cardAttempts}>
                          Signing value {e.hasSecret ? 'set' : 'not set'}
                        </span>
                      </>
                    }
                  >
                    <span className={styles.cardActions}>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() =>
                          askFor(`test:${e.id}`, {
                            title: 'Send a test message',
                            verb: 'Send test',
                            requires: `${OPERATOR} The address must resolve to a public host.`,
                            changes: 'One message is posted to this address now, with no retry.',
                            undo: 'Nothing. A message already sent cannot be recalled.',
                            irreversible: true,
                            run: () =>
                              call('/api/notifications/test', { method: 'POST', body: { endpointId: e.id } }),
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
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          askFor(`clear:${e.id}`, {
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
                      </Button>
                    </span>
                    {ask?.key?.endsWith(`:${e.id}`) ? (
                      <InlineConfirm {...ask} busy={busy} refusal={deny} onConfirm={confirm} onCancel={cancel} />
                    ) : null}
                  </Card>
                );
              })}
            </BoardGroup>
          ) : null}

          {visibleDeliveries.length ? (
            <BoardGroup
              label="Deliveries"
              tone={failed ? 'refusal' : null}
              count={visibleDeliveries.length}
            >
              {visibleDeliveries.map((d, i) => (
                <Card
                  key={`${d.at}-${i}`}
                  id={`${d.at}-${i}`}
                  bucket={d.ok ? undefined : 'attention'}
                  label={`Delivery to ${named(d.endpointId)}`}
                  head={
                    <div className={board.identityText}>
                      <span className={styles.name}>
                        {named(d.endpointId)}
                      </span>
                      <small>{EVENTS[d.event] || d.event}</small>
                    </div>
                  }
                  state={
                    <>
                      <StateWord tone={d.ok ? 'positive' : 'refusal'}>
                        {d.state ? DELIVERY_WORD[d.state] ?? d.state : d.ok ? 'Delivered' : 'Not delivered'}
                      </StateWord>
                      <span className={board.spacer} />
                      <span className={board.cardAttempts}>{fmtRelative(d.at)}</span>
                    </>
                  }
                >
                  <p className={styles.note}>
                    {[d.status ? `HTTP ${d.status}` : null, d.attempts ? `${fmtNum(d.attempts)}x` : null, d.error]
                      .filter(Boolean)
                      .join(' · ') || 'No further detail was retained.'}
                  </p>
                </Card>
              ))}
            </BoardGroup>
          ) : null}

          <div className={board.messages}>
            {notif.loading && !cfg ? (
              <div className={board.empty}>
                <Loader size="xs" /> Reading destinations…
              </div>
            ) : null}
            {cfg && !endpoints.length ? (
              <div className={board.empty}>
                No destination is configured. Add one above; until then nothing is sent anywhere.
              </div>
            ) : null}
            {notif.data && !deliveries.length && endpoints.length ? (
              <div className={board.empty}>Never sent. A delivery appears here once an event fires.</div>
            ) : null}
            {endpoints.length && !visibleEndpoints.length && !visibleDeliveries.length ? (
              <div className={board.empty}>
                Nothing matches.{' '}
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

        <p className={styles.note}>
          The latest fifty delivery results are retained. Rule and project alerts keep their delivery
          state across restarts, an unconfirmed send is never automatically replayed after a stopped
          sender, and an account is seeded silently the first time it is seen so a restart does not
          replay an old incident. A destination that does not answer delays no request and fails none.
        </p>
      </div>
    </div>
  );
}
