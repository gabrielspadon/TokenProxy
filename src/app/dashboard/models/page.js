'use client';
import { useMemo, useState } from 'react';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit } from '@/shared/format';
import { Icon } from '@/shared/components/Icon';
import './styles.css';

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

const OPERATOR = 'An operator session.';
const CAPACITY_KINDS = [
  { key: 'vision', label: 'Vision input' },
  { key: 'pdf', label: 'PDF input' },
  { key: 'audioInput', label: 'Audio input' },
  { key: 'videoInput', label: 'Video input' },
];
const STRATEGIES = ['fallback', 'round-robin', 'fusion'];

// Every disable/enable and combo-strategy write touches routing state a
// request already in flight has read, so every mutation here carries the
// same one-line consequence text.
const NEXT_REQUEST =
  'New requests take the change. A request already in flight keeps what it started with.';

export default function ModelsPage() {
  const models = usePoll('/api/models', 30000);
  const disabled = usePoll('/api/models/disabled', 30000);
  const custom = usePoll('/api/models/custom', 30000);
  const news = usePoll('/api/models/new', 60000);
  const freeSync = usePoll('/api/models/free-sync', 30000);
  const combos = usePoll('/api/combos', 15000);
  const settings = usePoll('/api/settings', 30000);
  const conns = usePoll('/api/admin/health/detail', 30000);

  const [q, setQ] = useState('');
  const [pending, setPending] = useState(null); // {kind, ...} drives the Confirm dialog
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const [done, setDone] = useState(null);
  const [form, setForm] = useState({});
  const [now] = useState(() => Date.now());
  const [showAll, setShowAll] = useState(false);

  const rows = models.data?.models || [];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (m) => m.fullModel.toLowerCase().includes(s) || (m.alias || '').toLowerCase().includes(s)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows is derived fresh each render from models.data, which is the real dependency
  }, [models.data, q]);

  // ponytail: plain slice cap, virtualize if the catalog ever needs to render whole
  const CAP = 25;
  const shown = showAll || filtered.length <= CAP ? filtered : filtered.slice(0, CAP);

  const connections = conns.data?.checks?.connections || [];
  const disabledByProvider = disabled.data?.disabled || {};
  const customRows = custom.data?.models || [];
  const groups = news.data?.groups || [];
  const totalUnseen = news.data?.totalUnseen || 0;
  const comboRows = combos.data?.combos || [];
  const s = settings.data;

  const close = () => {
    setPending(null);
    setFailed(null);
    setForm({});
  };

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    setFailed(null);
    const res = await pending.request();
    setBusy(false);
    if (!res.ok) {
      setFailed(refusal(res.status, res.body));
      return;
    }
    setDone(pending.done);
    setPending(null);
    setForm({});
    pending.refresh?.forEach((p) => p.refresh());
  };

  // --- Aliases ---
  const openAlias = (m) => {
    setFailed(null);
    setForm({ alias: m.alias === m.model ? '' : m.alias });
    setPending({
      kind: 'alias',
      model: m.fullModel,
      label: m.fullModel,
      title: 'Set an alias',
      verb: 'Save',
      requires: OPERATOR,
      changes: `Lets a client address ${m.fullModel} by a short name instead of its full identifier. ${NEXT_REQUEST}`,
      undo: 'Delete the alias here. The model still routes by its full identifier.',
      request: () =>
        call('/api/models/alias', {
          method: 'PUT',
          body: { model: m.fullModel, alias: form.alias?.trim() },
        }),
      done: 'Alias saved.',
      refresh: [models],
    });
  };
  const openDeleteAlias = (m) => {
    setFailed(null);
    setPending({
      kind: 'deleteAlias',
      label: m.alias,
      title: 'Delete this alias',
      verb: 'Delete',
      requires: OPERATOR,
      changes: `A client addressing this model as "${m.alias}" is refused from its next request. The model itself is unaffected.`,
      undo: 'Set the alias again here.',
      irreversible: true,
      request: () =>
        call(`/api/models/alias?alias=${encodeURIComponent(m.alias)}`, { method: 'DELETE' }),
      done: 'Alias deleted.',
      refresh: [models],
    });
  };

  // --- Disabled models (provider-wide or per-connection) ---
  const openDisableToggle = (m, connectionId) => {
    const alias = m.alias === m.model ? m.provider : m.provider; // providerAlias for the API is the routing alias TokenProxy already resolved server-side
    const providerAlias = m.provider;
    const scope = connectionId
      ? connections.find((c) => c.connectionId === connectionId)?.displayName || connectionId
      : 'every connection on this provider';
    setFailed(null);
    setPending({
      kind: 'disable',
      label: m.fullModel,
      title: `Disable ${m.fullModel}`,
      verb: 'Disable',
      requires: OPERATOR,
      changes: `Removes ${m.fullModel} from routing for ${scope}. ${connectionId ? 'This connection gets its own disabled list; it stops inheriting the provider-wide one.' : ''} ${NEXT_REQUEST}`,
      undo: 'Enable it again here.',
      request: () =>
        call('/api/models/disabled', {
          method: 'POST',
          body: { providerAlias, ids: [m.model], connectionId: connectionId || null },
        }),
      done: 'Disabled.',
      refresh: [models, disabled],
    });
  };
  const openEnable = (providerAlias, id, connectionId, label) => {
    setFailed(null);
    setPending({
      kind: 'enable',
      label,
      title: `Enable ${label}`,
      verb: 'Enable',
      requires: OPERATOR,
      changes: `Offers ${label} for routing again. ${NEXT_REQUEST}`,
      undo: 'Disable it again here.',
      request: () =>
        call(
          `/api/models/disabled?providerAlias=${encodeURIComponent(providerAlias)}&id=${encodeURIComponent(id)}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ''}`,
          { method: 'DELETE' }
        ),
      done: 'Enabled.',
      refresh: [models, disabled],
    });
  };

  // --- Custom models ---
  const openAddCustom = () => {
    setFailed(null);
    setForm({ providerAlias: '', id: '', name: '', vision: false });
    setPending({
      kind: 'addCustom',
      title: 'Register a custom model',
      verb: 'Register',
      requires: OPERATOR,
      changes: `Adds a model id to the catalog for a provider node by hand, so it is offered for routing without being auto-discovered first. ${NEXT_REQUEST}`,
      undo: 'Delete it here.',
      request: () =>
        call('/api/models/custom', {
          method: 'POST',
          body: {
            providerAlias: form.providerAlias?.trim(),
            id: form.id?.trim(),
            name: form.name?.trim() || undefined,
            vision: !!form.vision,
            maxInputTokens: form.maxInputTokens ? Number(form.maxInputTokens) : undefined,
            maxOutputTokens: form.maxOutputTokens ? Number(form.maxOutputTokens) : undefined,
          },
        }),
      done: 'Registered.',
      refresh: [models, custom],
    });
  };
  const openDeleteCustom = (m) => {
    setFailed(null);
    setPending({
      kind: 'deleteCustom',
      label: `${m.providerAlias}/${m.id}`,
      title: 'Delete this custom model',
      verb: 'Delete',
      requires: OPERATOR,
      changes:
        'Removes it from the catalog. A client addressing it directly is refused from its next request.',
      undo: 'Register it again here.',
      irreversible: true,
      request: () =>
        call(
          `/api/models/custom?providerAlias=${encodeURIComponent(m.providerAlias)}&id=${encodeURIComponent(m.id)}&type=${encodeURIComponent(m.type || 'llm')}`,
          { method: 'DELETE' }
        ),
      done: 'Deleted.',
      refresh: [models, custom],
    });
  };

  // --- New / unseen models ---
  const ackOne = async (providerAlias, modelId) => {
    setDone(null);
    const res = await call('/api/models/new/acknowledge', {
      method: 'POST',
      body: { items: [{ providerAlias, modelId }] },
    });
    if (!res.ok) {
      setDone(null);
      setFailed(refusal(res.status, res.body));
      return;
    }
    news.refresh();
  };
  const openAckAll = () => {
    setFailed(null);
    setPending({
      kind: 'ackAll',
      title: 'Acknowledge every new model',
      verb: 'Acknowledge',
      requires: OPERATOR,
      changes: `Marks all ${totalUnseen} currently-unseen model${totalUnseen === 1 ? '' : 's'} as acknowledged. It does not change routing or which models are offered.`,
      undo: 'None. A model reappears here only if it is removed and observed again.',
      request: () => call('/api/models/new/acknowledge', { method: 'POST' }),
      done: 'Acknowledged.',
      refresh: [news],
    });
  };

  // --- Free-tier sync ---
  const triggerFreeSync = async () => {
    setDone(null);
    setFailed(null);
    const res = await call('/api/models/free-sync', { method: 'POST' });
    if (!res.ok) {
      setFailed(refusal(res.status, res.body));
      return;
    }
    if (res.body?.skipped) {
      setDone(
        `Not run: ${res.body.reason === 'already-running' ? 'a sync is already running.' : res.body.reason}`
      );
    } else {
      setDone(
        `Synced. +${fmtNum(res.body?.added || 0)} / -${fmtNum(res.body?.removed || 0)} across ${fmtNum(Object.keys(res.body?.providers || {}).length)} providers.`
      );
    }
    freeSync.refresh();
    models.refresh();
    custom.refresh();
  };

  // --- Combos ---
  const openCreateCombo = () => {
    setFailed(null);
    setForm({ name: '', models: '', kind: '' });
    setPending({
      kind: 'createCombo',
      title: 'Create a combo',
      verb: 'Create',
      requires: OPERATOR,
      changes: `Adds a named chain a client can route to as one model. ${NEXT_REQUEST}`,
      undo: 'Delete it here.',
      request: () =>
        call('/api/combos', {
          method: 'POST',
          body: {
            name: form.name?.trim(),
            kind: form.kind?.trim() || null,
            models: String(form.models || '')
              .split(/[\n,]/)
              .map((x) => x.trim())
              .filter(Boolean),
          },
        }),
      done: 'Created.',
      refresh: [combos],
    });
  };
  const openEditCombo = (c) => {
    setFailed(null);
    setForm({ name: c.name, models: (c.models || []).join(', '), kind: c.kind || '' });
    setPending({
      kind: 'editCombo',
      id: c.id,
      label: c.name,
      title: `Edit ${c.name}`,
      verb: 'Save',
      requires: OPERATOR,
      changes: `Replaces this combo's member list and resets its rotation state, so the next request restarts from the first strategy step. ${NEXT_REQUEST}`,
      undo: 'Set the previous member list again here.',
      request: () =>
        call(`/api/combos/${encodeURIComponent(c.id)}`, {
          method: 'PUT',
          body: {
            name: form.name?.trim(),
            kind: form.kind?.trim() || null,
            models: String(form.models || '')
              .split(/[\n,]/)
              .map((x) => x.trim())
              .filter(Boolean),
          },
        }),
      done: 'Saved.',
      refresh: [combos],
    });
  };
  const openDeleteCombo = (c) => {
    setFailed(null);
    setPending({
      kind: 'deleteCombo',
      label: c.name,
      title: `Delete ${c.name}`,
      verb: 'Delete',
      requires: OPERATOR,
      changes: `Removes the combo. A client addressing "${c.name}" directly is refused from its next request; each of its ${(c.models || []).length} member model${(c.models || []).length === 1 ? '' : 's'} keeps routing on its own name.`,
      undo: 'Create a combo with the same name and member list here.',
      irreversible: true,
      request: () => call(`/api/combos/${encodeURIComponent(c.id)}`, { method: 'DELETE' }),
      done: 'Deleted.',
      refresh: [combos],
    });
  };

  // --- Combo strategy defaults + capacity adapter (settings PATCH) ---
  const saveComboDefaults = () => {
    setFailed(null);
    setPending({
      kind: 'comboDefaults',
      title: 'Save the default combo strategy',
      verb: 'Save',
      requires: OPERATOR,
      changes: `Every combo with no override of its own uses this strategy and stickiness from its next request.`,
      undo: 'Set the previous values again here.',
      request: () =>
        call('/api/settings', {
          method: 'PATCH',
          body: {
            comboStrategy: form.comboStrategy,
            comboStickyRoundRobinLimit: Number(form.comboStickyRoundRobinLimit) || 1,
          },
        }),
      done: 'Saved.',
      refresh: [settings],
    });
  };
  const toggleComboOnly = async () => {
    setDone(null);
    const res = await call('/api/settings', {
      method: 'PATCH',
      body: { exposeComboOnly: !s?.exposeComboOnly },
    });
    if (!res.ok) {
      setFailed(refusal(res.status, res.body));
      return;
    }
    settings.refresh();
  };
  const saveCapacity = (key) => {
    setFailed(null);
    setPending({
      kind: 'capacity',
      label: CAPACITY_KINDS.find((c) => c.key === key)?.label,
      capKey: key,
      title: `Save ${CAPACITY_KINDS.find((c) => c.key === key)?.label} auto-routing`,
      verb: 'Save',
      requires: OPERATOR,
      changes: `Replaces the whole auto-routing configuration (all four kinds), because the gateway only accepts it as one object. ${NEXT_REQUEST}`,
      undo: 'Set the previous values again here.',
      request: () =>
        call('/api/settings', {
          method: 'PATCH',
          body: { capacityAdapter: buildCapacityBody(s?.capacityAdapter, key, form) },
        }),
      done: 'Saved.',
      refresh: [settings],
    });
  };

  const s6errors = models.error && !models.data ? refusal(models.status, models.error) : null;

  return (
    <>
      <div className="screen-head">
        <h1>Models</h1>
        <Freshness status={pollFresh(models)} lastDataAt={models.goodAt} />
      </div>
      {done ? <Notice tone="ok" title={done} /> : null}

      <div className="measures">
        <div className="measure big">
          <span className="label">Catalog</span>
          <span className="value" data-i18n-skip>
            {models.data ? fmtNum(rows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Combos</span>
          <span className="value" data-i18n-skip>
            {combos.data ? fmtNum(comboRows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Custom</span>
          <span className="value" data-i18n-skip>
            {custom.data ? fmtNum(customRows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Disabled aliases</span>
          <span className="value" data-i18n-skip>
            {disabled.data ? fmtNum(Object.keys(disabledByProvider).length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Unacknowledged</span>
          <span className="value" data-i18n-skip>
            {news.data ? fmtNum(totalUnseen) : '—'}
          </span>
        </div>
      </div>

      <section aria-labelledby="h-catalog">
        <div className="screen-head models-catalog-head">
          <h2 id="h-catalog">Catalog</h2>
          <label className="field models-search">
            <span>Search</span>
            <input
              className="input"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="model id or alias"
            />
          </label>
        </div>
        {s6errors ? <Notice {...s6errors} /> : null}
        {models.loading && !models.data ? <p className="skeleton">Reading</p> : null}
        {models.data && filtered.length === 0 ? (
          <p className="empty">
            {rows.length === 0
              ? 'No model is available. A model appears once a provider is connected.'
              : 'No model matches this search.'}
          </p>
        ) : null}
        {filtered.length ? (
          <div className="rows model-catalog-list" tabIndex={0} aria-label="Model catalog">
            <div className="row head models-row">
              <span>Model</span>
              <span>Capabilities</span>
              <span>Context / output</span>
              <span />
            </div>
            {shown.map((m) => (
              <div key={m.fullModel} className="row models-row">
                <span className="who">
                  <span className="name id" data-i18n-skip>
                    {m.fullModel}
                  </span>
                  <span className="sub">
                    {m.alias !== m.model ? (
                      <>
                        alias{' '}
                        <span className="id" data-i18n-skip>
                          {m.alias}
                        </span>
                      </>
                    ) : (
                      <span>No alias</span>
                    )}
                  </span>
                </span>
                <span data-i18n-skip>
                  {[
                    m.caps?.vision && 'Vision',
                    m.caps?.search && 'Search',
                    m.caps?.reasoning && 'Reasoning',
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </span>
                <span data-i18n-skip>
                  {m.caps?.contextWindow ? fmtNum(m.caps.contextWindow) : '?'} /{' '}
                  {m.caps?.maxOutput ? fmtNum(m.caps.maxOutput) : '?'}
                </span>
                <span className="actions">
                  <button type="button" className="link-button" onClick={() => openAlias(m)}>
                    {m.alias !== m.model ? 'Edit alias' : 'Set alias'}
                  </button>
                  {m.alias !== m.model ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => openDeleteAlias(m)}
                    >
                      Delete alias
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => openDisableToggle(m, null)}
                  >
                    Disable
                  </button>
                </span>
              </div>
            ))}
            {shown.length < filtered.length ? (
              <div className="row models-row">
                <span className="caption">
                  Showing <span data-i18n-skip>{fmtNum(shown.length)}</span> of{' '}
                  <span data-i18n-skip>{fmtNum(filtered.length)}</span> models. Search narrows the
                  list.
                </span>
                <span />
                <span />
                <button type="button" className="button" onClick={() => setShowAll(true)}>
                  Show every model
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-disabled">
        <h2 id="h-disabled">Disabled models</h2>
        <p>
          A provider-wide list applies to every connection that has never had its own. The moment a
          connection gets its own list, editing it never touches the provider-wide one or any other
          connection&apos;s inherited copy.
        </p>
        {disabled.error && !disabled.data ? (
          <Notice {...refusal(disabled.status, disabled.error)} />
        ) : null}
        {disabled.data && Object.keys(disabledByProvider).length === 0 ? (
          <p className="empty">No provider has a disabled model.</p>
        ) : null}
        {Object.keys(disabledByProvider).length ? (
          <div className="rows">
            {Object.entries(disabledByProvider).map(([alias, ids]) => (
              <div
                key={alias}
                className="row"
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
              >
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {alias}
                  </span>
                  <span className="sub id" data-i18n-skip>
                    {ids.join(', ')}
                  </span>
                </span>
                <span className="actions">
                  {ids.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="link-button"
                      onClick={() => openEnable(alias, id, null, `${alias}/${id}`)}
                    >
                      Enable {id}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-custom" className="panel">
        <div className="screen-head">
          <h2 id="h-custom">Custom models</h2>
          <button type="button" className="button" onClick={openAddCustom}>
            <Icon name="i-add" />
            Register a model
          </button>
        </div>
        {custom.error && !custom.data ? <Notice {...refusal(custom.status, custom.error)} /> : null}
        {custom.data && customRows.length === 0 ? (
          <p className="empty">No custom model is registered.</p>
        ) : null}
        {customRows.length ? (
          <div className="rows">
            {customRows.map((m) => (
              <div
                key={`${m.providerAlias}/${m.id}`}
                className="row"
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
              >
                <span className="who">
                  <span className="name id" data-i18n-skip>
                    {m.providerAlias}/{m.id}
                  </span>
                  <span className="sub" data-i18n-skip>
                    {m.name || m.id}
                    {m.vision ? ' · vision' : ''}
                    {m.maxInputTokens ? ` · ${fmtNum(m.maxInputTokens)} in` : ''}
                    {m.maxOutputTokens ? ` · ${fmtNum(m.maxOutputTokens)} out` : ''}
                  </span>
                </span>
                <button type="button" className="button danger" onClick={() => openDeleteCustom(m)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-new">
        <div className="screen-head">
          <h2 id="h-new">Newly observed models</h2>
          <Freshness status={pollFresh(news)} lastDataAt={news.goodAt} />
        </div>
        {news.error && !news.data ? <Notice {...refusal(news.status, news.error)} /> : null}
        {news.data?.seeded ? (
          <Notice
            tone="ok"
            title="First scan seeded."
            next="Everything already present was marked already-acknowledged, so nothing pre-existing shows here as new."
          />
        ) : null}
        {news.data && !news.data.seeded && groups.length === 0 ? (
          <p className="empty">No model is unacknowledged.</p>
        ) : null}
        {groups.length ? (
          <>
            <div className="actions">
              <button type="button" className="button quiet" onClick={openAckAll}>
                Acknowledge all ({fmtNum(totalUnseen)})
              </button>
            </div>
            <div className="rows">
              {groups.map((g) => (
                <div key={g.providerAlias} className="row" style={{ gridTemplateColumns: '1fr' }}>
                  <span className="who">
                    <span className="name" data-i18n-skip>
                      {g.providerName}
                    </span>
                  </span>
                  <div className="rows">
                    {g.models.map((m) => (
                      <div
                        key={m.modelId}
                        className="row"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}
                      >
                        <span className="id" data-i18n-skip>
                          {m.modelId}
                        </span>
                        <span className="status" data-tone={m.isNew ? 'warn' : undefined}>
                          {m.isNew ? 'New' : 'Unacknowledged'}
                          {m.isFree ? ' · free' : ''}
                        </span>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => ackOne(g.providerAlias, m.modelId)}
                        >
                          Acknowledge
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-free">
        <div className="screen-head">
          <h2 id="h-free">Free-tier discovery</h2>
          <Freshness status={pollFresh(freeSync)} lastDataAt={freeSync.goodAt} />
        </div>
        {freeSync.error && !freeSync.data ? (
          <Notice {...refusal(freeSync.status, freeSync.error)} />
        ) : null}
        {freeSync.data ? (
          <>
            <dl className="facts">
              <dt>Scheduler</dt>
              <dd>
                <span className="status" data-tone={freeSync.data.config?.enabled ? 'ok' : 'warn'}>
                  {freeSync.data.config?.enabled ? 'On' : 'Off'}
                </span>{' '}
                <span data-i18n-skip>
                  every {fmtUnit(freeSync.data.config?.intervalHours, 'hour')}
                </span>
              </dd>
              <dt>Last run</dt>
              <dd>
                {freeSync.data.running ? (
                  <span className="status" data-tone="ok">
                    Running now
                  </span>
                ) : freeSync.data.lastRunAt ? (
                  <span data-i18n-skip>{fmtRelative(freeSync.data.lastRunAt, now)}</span>
                ) : (
                  <span className="unreported">Not reported</span>
                )}
                {freeSync.data.lastError ? (
                  <span className="caption" data-i18n-skip>
                    {' '}
                    {freeSync.data.lastError}
                  </span>
                ) : null}
              </dd>
            </dl>
            {Object.keys(freeSync.data.providers || {}).length ? (
              <div className="rows">
                {Object.entries(freeSync.data.providers).map(([id, p]) => (
                  <div
                    key={id}
                    className="row"
                    style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
                  >
                    <span className="name" data-i18n-skip>
                      {id}
                    </span>
                    <span data-i18n-skip>
                      {fmtNum(p.count)} models
                      {p.updatedAt ? <> · {fmtRelative(p.updatedAt, now)}</> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">No free-tier provider has synced yet.</p>
            )}
            <div className="actions">
              <button type="button" className="button quiet" onClick={triggerFreeSync}>
                Sync now
              </button>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-combos" className="panel">
        <div className="screen-head">
          <h2 id="h-combos">Combos</h2>
          <button type="button" className="button" onClick={openCreateCombo}>
            <Icon name="i-add" />
            Create a combo
          </button>
        </div>
        {combos.error && !combos.data ? <Notice {...refusal(combos.status, combos.error)} /> : null}
        {combos.data && comboRows.length === 0 ? (
          <p className="empty">
            No combo is defined. A client may only address a bare model until one exists.
          </p>
        ) : null}
        {comboRows.length ? (
          <div className="rows">
            {comboRows.map((c) => {
              const override = s?.comboStrategies?.[c.name];
              return (
                <div
                  key={c.id}
                  className="row"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
                >
                  <span className="who">
                    <span className="name id" data-i18n-skip>
                      {c.name}
                    </span>
                    <span className="sub id" data-i18n-skip>
                      {(c.models || []).join(', ')}
                    </span>
                    <span className="sub">
                      {override?.fallbackStrategy ? (
                        <>
                          override <span data-i18n-skip>{override.fallbackStrategy}</span>
                        </>
                      ) : (
                        <>uses the default strategy</>
                      )}
                    </span>
                  </span>
                  <span className="actions">
                    <button type="button" className="link-button" onClick={() => openEditCombo(c)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => openDeleteCombo(c)}
                    >
                      Delete
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-decisions" className="panel">
        <div className="screen-head">
          <h2 id="h-decisions">Routing decisions</h2>
          <Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} />
        </div>
        {settings.error && !s ? <Notice {...refusal(settings.status, settings.error)} /> : null}
        {s ? (
          <>
            <div className="models-form">
              <label className="field">
                <span>Default combo strategy</span>
                <select
                  className="select"
                  value={form.comboStrategy ?? s.comboStrategy}
                  onChange={(e) => setForm((f) => ({ ...f, comboStrategy: e.target.value }))}
                >
                  {STRATEGIES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Sticky round-robin limit</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={form.comboStickyRoundRobinLimit ?? s.comboStickyRoundRobinLimit}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, comboStickyRoundRobinLimit: e.target.value }))
                  }
                />
              </label>
            </div>
            <div className="verb-row">
              <button type="button" className="button" onClick={saveComboDefaults}>
                <Icon name="i-edit" />
                Save defaults
              </button>
            </div>
            <dl className="facts">
              <dt>Combos only</dt>
              <dd>
                <span className="status" data-tone={s.exposeComboOnly ? 'warn' : 'ok'}>
                  {s.exposeComboOnly
                    ? 'Only named combos may be requested'
                    : 'Bare models and combos may both be requested'}
                </span>{' '}
                <button type="button" className="link-button" onClick={toggleComboOnly}>
                  {s.exposeComboOnly ? 'Allow bare models' : 'Restrict to combos'}
                </button>
              </dd>
            </dl>
            <h3>Capability-based auto-routing</h3>
            <div className="rows">
              {CAPACITY_KINDS.map((k) => {
                const cfg = s.capacityAdapter?.[k.key] || {};
                return (
                  <div
                    key={k.key}
                    className="row"
                    style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
                  >
                    <span className="who">
                      <span className="name">{k.label}</span>
                      <span className="sub">
                        <label>
                          <input
                            type="checkbox"
                            checked={form[`${k.key}.enabled`] ?? cfg.enabled ?? false}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, [`${k.key}.enabled`]: e.target.checked }))
                            }
                          />{' '}
                          Enabled
                        </label>{' '}
                        <label>
                          <input
                            type="checkbox"
                            checked={form[`${k.key}.roundRobin`] ?? cfg.roundRobin ?? false}
                            onChange={(e) =>
                              setForm((f) => ({ ...f, [`${k.key}.roundRobin`]: e.target.checked }))
                            }
                          />{' '}
                          Rotate among eligible models
                        </label>
                      </span>
                      <input
                        className="input"
                        type="text"
                        placeholder="eligible model ids, comma separated"
                        value={form[`${k.key}.models`] ?? (cfg.models || []).join(', ')}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, [`${k.key}.models`]: e.target.value }))
                        }
                      />
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => saveCapacity(k.key)}
                    >
                      Save
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-gap">
        <h2 id="h-gap">Not reported</h2>
        <ul className="bullets">
          <li>
            The connection-scoped disabled-model view above reads connections from the health detail
            scan, which can run short if that scan did not finish; a connection missing there cannot
            get its own disabled list from this screen until the next successful scan.
          </li>
          <li>
            What the client-compatibility namespace in §13 actually advertises (rewritten names,
            hidden models) has no route of its own and is not shown here; only the true catalog is.
          </li>
        </ul>
      </section>

      <Confirm
        open={!!pending}
        busy={busy}
        refusal={failed}
        title={pending?.title}
        verb={pending?.verb}
        requires={pending?.requires}
        changes={pending?.changes}
        undo={pending?.undo}
        irreversible={!!pending?.irreversible}
        onConfirm={run}
        onClose={close}
      >
        {pending?.label ? (
          <p className="name id" data-i18n-skip>
            {pending.label}
          </p>
        ) : null}
        {pending?.kind === 'alias' ? (
          <label className="field">
            <span>Alias</span>
            <input
              className="input"
              type="text"
              value={form.alias || ''}
              onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
            />
          </label>
        ) : null}
        {pending?.kind === 'addCustom' ? (
          <div className="models-form">
            <label className="field">
              <span>Provider</span>
              <input
                className="input"
                type="text"
                value={form.providerAlias || ''}
                onChange={(e) => setForm((f) => ({ ...f, providerAlias: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Model id</span>
              <input
                className="input"
                type="text"
                value={form.id || ''}
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                type="text"
                value={form.name || ''}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Context window</span>
              <input
                className="input"
                type="number"
                min="1"
                value={form.maxInputTokens || ''}
                onChange={(e) => setForm((f) => ({ ...f, maxInputTokens: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Max output</span>
              <input
                className="input"
                type="number"
                min="1"
                value={form.maxOutputTokens || ''}
                onChange={(e) => setForm((f) => ({ ...f, maxOutputTokens: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>
                <input
                  type="checkbox"
                  checked={!!form.vision}
                  onChange={(e) => setForm((f) => ({ ...f, vision: e.target.checked }))}
                />{' '}
                Vision
              </span>
            </label>
          </div>
        ) : null}
        {pending?.kind === 'createCombo' || pending?.kind === 'editCombo' ? (
          <div className="models-form">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                type="text"
                disabled={pending.kind === 'editCombo'}
                value={form.name || ''}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Kind</span>
              <input
                className="input"
                type="text"
                value={form.kind || ''}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Members</span>
              <input
                className="input"
                type="text"
                value={form.models || ''}
                onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
              />
            </label>
            <p className="caption">One model id per entry, in order, separated by commas.</p>
          </div>
        ) : null}
      </Confirm>
    </>
  );
}

// capacityAdapter must PATCH as the full 4-key object: settingsRepo's
// updateSettings() merge-list excludes it, so a partial write would drop the
// other three capabilities back to whatever the seeded defaults hold.
function buildCapacityBody(current, key, form) {
  const base = current || {};
  const next = {};
  for (const k of ['vision', 'pdf', 'audioInput', 'videoInput']) {
    const cur = base[k] || { enabled: false, roundRobin: false, models: [] };
    if (k === key) {
      next[k] = {
        enabled: form[`${k}.enabled`] ?? cur.enabled,
        roundRobin: form[`${k}.roundRobin`] ?? cur.roundRobin,
        models: (form[`${k}.models`] !== undefined
          ? form[`${k}.models`]
          : (cur.models || []).join(', ')
        )
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      };
    } else {
      next[k] = cur;
    }
  }
  return next;
}
