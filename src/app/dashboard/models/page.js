'use client';
import { useState } from 'react';
import { ActionIcon, Button, Loader, MultiSelect, Select, Switch, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtRelative, fmtUnit } from '@/shared/format';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { ModelsPolicy } from '@/shared/models-policy/ModelsPolicy';
import { AutoRouting } from '@/shared/models-policy/AutoRouting';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  useLevel,
} from '@/shared/workspace/Board';
import { CommitNumber, CommitText } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { useConfiguredModels } from '@/shared/workspace/useConfiguredModels';
import { widestOf, windowMeter } from '@/shared/workspace/windowMeter';
import styles from '@/shared/workspace/board.module.css';
import { CatalogTools } from './CatalogTools';
import {
  BUCKETS,
  SORTS,
  buildCapacityBody,
  capabilityWords,
  catalogBucket,
  catalogEntries,
  catalogSummary,
  filterCatalog,
  sortCatalog,
} from './catalogBoardModel';
import './styles.css';

const CAP = 60;
const TONE = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, bucket.tone]));
const WORD = {
  new: 'Unacknowledged',
  disabled: 'Disabled',
  aliased: 'Aliased',
  custom: 'Registered',
  catalog: 'Offered',
};
const CAPABILITY_KINDS = [
  { key: 'vision', label: 'Vision input' },
  { key: 'pdf', label: 'PDF input' },
  { key: 'audioInput', label: 'Audio input' },
  { key: 'videoInput', label: 'Video input' },
];
const STRATEGIES = ['fallback', 'round-robin', 'fusion'];
const NEXT_REQUEST =
  'New requests take the change. A request already in flight keeps what it started with.';

const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });

function report(result, message, title) {
  if (result.ok) {
    toast('teal', message, title);
    return true;
  }
  const failure = refusal(result.status, result.body);
  toast('orange', [failure.title, failure.detail, failure.next].filter(Boolean).join(' '), title);
  return false;
}

export default function ModelsPage() {
  return (
    <ModelsPolicy
      automaticRouting={
        <>
          <AutoRouting />
          <CapabilityRouting />
        </>
      }
      catalogControls={<CatalogControls />}
      catalogTools={<CatalogTools />}
    />
  );
}

const compact = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : '—';

function CatalogEvidence({ entry, widest, widestOutput }) {
  const context = windowMeter(entry.context, widest);
  const output = windowMeter(entry.output, widestOutput);
  const words = capabilityWords(entry.caps);
  return (
    <>
      <EvidenceLine
        label="Context"
        remaining={context.remaining}
        level={context.level}
        unknown={context.unknown}
        value={compact(entry.context)}
        note={words.length > 2 ? `${words.slice(0, 2).join(' · ')} +${words.length - 2}` : words.join(' · ')}
        title={
          entry.context
            ? `${fmtNum(entry.context)} input tokens${words.length ? ` · ${words.join(', ')}` : ''}`
            : 'The catalog reports no context window for this model'
        }
      />
      <EvidenceLine
        label="Max output"
        remaining={output.remaining}
        level={output.level}
        unknown={output.unknown}
        value={compact(entry.output)}
        note={entry.free ? 'Free tier' : entry.custom ? 'By hand' : ''}
        title={
          entry.output
            ? `${fmtNum(entry.output)} completion tokens`
            : 'The catalog reports no output limit for this model'
        }
      />
    </>
  );
}

function AliasField({ entry, disabled, onCommit }) {
  return (
    <Tooltip label="A short name a client can address this model by. Enter or blur saves it.">
      <CommitText
        className="models-alias"
        aria-label={`Alias for ${entry.id}`}
        placeholder="No alias"
        value={entry.aliases?.[0] || ''}
        disabled={disabled}
        onCommit={onCommit}
      />
    </Tooltip>
  );
}

function CatalogActions({ entry, advanced, disabled, onDisable, onEnable, onAcknowledge, onDeleteCustom }) {
  return (
    <>
      {entry.unseen ? (
        <Tooltip label="Acknowledge: mark it seen. Routing is unchanged.">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Acknowledge ${entry.id}`}
            disabled={disabled}
            onClick={onAcknowledge}
          >
            <Icon name="i-check" />
          </ActionIcon>
        </Tooltip>
      ) : null}
      {entry.disabled ? (
        <Tooltip label={`Offer ${entry.id} for routing again. ${NEXT_REQUEST}`}>
          <ActionIcon
            variant="light"
            color="teal"
            aria-label={`Enable ${entry.id}`}
            disabled={disabled}
            onClick={onEnable}
          >
            <Icon name="i-play" />
          </ActionIcon>
        </Tooltip>
      ) : (
        <InlineConfirm
          label={`Disable ${entry.id}`}
          hint={`Removes ${entry.id} from routing for every connection on this provider. ${NEXT_REQUEST}`}
          verb="Disable"
          icon="i-pause"
          disabled={disabled}
          onConfirm={onDisable}
        />
      )}
      {advanced && entry.custom ? (
        <InlineConfirm
          label={`Delete the registered model ${entry.id}`}
          hint="Removes it from the catalog. A client addressing it directly is refused from its next request."
          verb="Delete"
          icon="i-close"
          tone="red"
          disabled={disabled}
          onConfirm={onDeleteCustom}
        />
      ) : null}
    </>
  );
}

// `density` and `onDensity` come from the page; only the catalog board, the
// first board on this tab, carries the page's single density switch.
export function CatalogControls({ density, onDensity }) {
  const advanced = useLevel();
  const models = usePoll('/api/models', 30000);
  const disabled = usePoll('/api/models/disabled', 30000);
  const custom = usePoll('/api/models/custom', 30000);
  const news = usePoll('/api/models/new', 60000);
  const freeSync = usePoll('/api/models/free-sync', 30000);
  const combos = usePoll('/api/combos', 15000);
  const settings = usePoll('/api/settings', 30000);

  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('name');
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ providerAlias: '', id: '', name: '', context: '', output: '' });
  const [busy, setBusy] = useState(null);
  const [now] = useState(() => Date.now());

  const entries = catalogEntries({
    models: models.data?.models,
    disabled: disabled.data?.disabled,
    custom: custom.data?.models,
    groups: news.data?.groups,
  });
  const summary = catalogSummary(entries);
  const widest = widestOf(entries.map((entry) => entry.context));
  const widestOutput = widestOf(entries.map((entry) => entry.output));
  const matching = sortCatalog(filterCatalog(entries, { query, bucket }), sort);
  const visible = showAll || matching.length <= CAP ? matching : matching.slice(0, CAP);
  const totalUnseen = news.data?.totalUnseen || 0;
  const readFailed = models.error && !models.data ? refusal(models.status, models.error) : null;

  function refresh() {
    models.refresh();
    disabled.refresh();
    custom.refresh();
    news.refresh();
  }

  async function run(id, request, message) {
    if (busy) return;
    setBusy(id);
    const result = await request();
    if (report(result, message, id)) refresh();
    setBusy(null);
  }

  const setAlias = (entry, alias) =>
    run(
      entry.id,
      () => call('/api/models/alias', { method: 'PUT', body: { model: entry.id, alias } }),
      `Alias saved. ${NEXT_REQUEST}`
    );
  const clearAlias = (entry, alias) =>
    run(
      entry.id,
      () => call(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' }),
      'Alias deleted. The model still routes by its full identifier.'
    );
  const disableModel = (entry) =>
    run(
      entry.id,
      () =>
        call('/api/models/disabled', {
          method: 'POST',
          body: { providerAlias: entry.provider, ids: [entry.model], connectionId: null },
        }),
      `Disabled. ${NEXT_REQUEST}`
    );
  const enableModel = (entry) =>
    run(
      entry.id,
      () =>
        call(
          `/api/models/disabled?providerAlias=${encodeURIComponent(entry.provider)}&id=${encodeURIComponent(entry.model)}`,
          { method: 'DELETE' }
        ),
      `Enabled. ${NEXT_REQUEST}`
    );
  const acknowledge = (entry) =>
    run(
      entry.id,
      () =>
        call('/api/models/new/acknowledge', {
          method: 'POST',
          body: { items: [{ providerAlias: entry.provider, modelId: entry.model }] },
        }),
      'Acknowledged. Routing is unchanged.'
    );
  const acknowledgeAll = () =>
    run(
      'catalog',
      () => call('/api/models/new/acknowledge', { method: 'POST' }),
      `${fmtNum(totalUnseen)} models acknowledged. Routing is unchanged.`
    );
  const deleteCustom = (entry) => {
    const row = (custom.data?.models || []).find(
      (item) => `${item.providerAlias}/${item.id}` === entry.id
    );
    return run(
      entry.id,
      () =>
        call(
          `/api/models/custom?providerAlias=${encodeURIComponent(entry.provider)}&id=${encodeURIComponent(entry.model)}&type=${encodeURIComponent(row?.type || 'llm')}`,
          { method: 'DELETE' }
        ),
      'Deleted from the catalog.'
    );
  };
  async function registerCustom(event) {
    event.preventDefault();
    if (!draft.providerAlias.trim() || !draft.id.trim()) {
      toast('orange', 'A provider alias and a model id are both required.', 'Register a model');
      return;
    }
    await run(
      `${draft.providerAlias}/${draft.id}`,
      () =>
        call('/api/models/custom', {
          method: 'POST',
          body: {
            providerAlias: draft.providerAlias.trim(),
            id: draft.id.trim(),
            name: draft.name.trim() || undefined,
            vision: false,
            maxInputTokens: draft.context ? Number(draft.context) : undefined,
            maxOutputTokens: draft.output ? Number(draft.output) : undefined,
          },
        }),
      `Registered. ${NEXT_REQUEST}`
    );
    setDraft({ providerAlias: '', id: '', name: '', context: '', output: '' });
    setAdding(false);
  }
  const commitAlias = (entry, value) => {
    const current = entry.aliases?.[0] || '';
    if (value === current) return;
    if (!value && current) return clearAlias(entry, current);
    return setAlias(entry, value);
  };

  const chips = [
    { id: null, label: entries.length === 1 ? 'model' : 'models', count: entries.length },
    ...BUCKETS.filter((item) => summary[item.id] > 0 || item.id === 'catalog').map((item) => ({
      id: item.id,
      tone: item.tone,
      label: item.label.toLowerCase(),
      count: summary[item.id],
    })),
  ];

  const rowProps = (entry) => ({
    advanced,
    disabled: Boolean(busy) || Boolean(readFailed),
    onDisable: () => disableModel(entry),
    onEnable: () => enableModel(entry),
    onAcknowledge: () => acknowledge(entry),
    onDeleteCustom: () => deleteCustom(entry),
  });

  return (
    <>
      <Board label="Model catalog" advanced={advanced} density={density} compare="none">
        <BoardSummary
          label="Catalog summary"
          chips={chips}
          active={bucket}
          onPick={(value) => {
            setBucket(value);
            setShowAll(false);
          }}
          note={
            models.loading && !models.data
              ? 'Reading the catalog…'
              : advanced
                ? 'Edits save on Enter or blur'
                : 'Advanced adds sorting and removal of models registered by hand'
          }
        />
        <BoardToolbar
          search={query}
          onSearch={(value) => {
            setQuery(value);
            setShowAll(false);
          }}
          searchLabel="Search the catalog by model id or alias"
          actions={
            <>
              {totalUnseen > 0 ? (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<Icon name="i-check" />}
                  disabled={Boolean(busy)}
                  onClick={acknowledgeAll}
                >
                  Acknowledge {fmtNum(totalUnseen)}
                </Button>
              ) : null}
              <Button
                size="xs"
                leftSection={<Icon name="i-add" />}
                aria-expanded={adding}
                onClick={() => setAdding((value) => !value)}
              >
                Register a model
              </Button>
              <Tooltip label="Re-read the catalog, its aliases and its disabled list">
                <ActionIcon
                  variant="default"
                  aria-label="Refresh the catalog"
                  loading={models.loading}
                  onClick={refresh}
                >
                  <Icon name="i-refresh" />
                </ActionIcon>
              </Tooltip>
            </>
          }
        >
          {advanced ? (
            <Select
              size="xs"
              aria-label="Sort the catalog"
              data={SORTS}
              value={sort}
              onChange={(value) => value && setSort(value)}
              leftSection={<Icon name="i-sort" />}
              className={styles.sort}
              allowDeselect={false}
            />
          ) : null}
          {onDensity ? <DensitySwitch value={density} onChange={onDensity} /> : null}
        </BoardToolbar>
        {adding ? (
          <form className={styles.addRow} aria-label="Register a custom model" onSubmit={registerCustom}>
            <CommitText
              className={styles.addProvider}
              aria-label="Provider alias"
              placeholder="Provider alias"
              value={draft.providerAlias}
              onCommit={(value) => setDraft((previous) => ({ ...previous, providerAlias: value }))}
            />
            <CommitText
              className={styles.addName}
              aria-label="Model id"
              placeholder="Model id"
              value={draft.id}
              onCommit={(value) => setDraft((previous) => ({ ...previous, id: value }))}
            />
            <CommitText
              className={styles.addName}
              aria-label="Display name"
              placeholder="Display name"
              value={draft.name}
              onCommit={(value) => setDraft((previous) => ({ ...previous, name: value }))}
            />
            <CommitNumber
              className={styles.addMode}
              aria-label="Context window"
              placeholder="Context"
              min={1}
              value={draft.context}
              onCommit={(value) => setDraft((previous) => ({ ...previous, context: value }))}
            />
            <CommitNumber
              className={styles.addMode}
              aria-label="Max output"
              placeholder="Max output"
              min={1}
              value={draft.output}
              onCommit={(value) => setDraft((previous) => ({ ...previous, output: value }))}
            />
            <Button size="xs" type="submit" disabled={Boolean(busy)}>
              Register
            </Button>
            <Button size="xs" variant="default" onClick={() => setAdding(false)}>
              Close
            </Button>
          </form>
        ) : null}
        {readFailed ? (
          <Text size="xs" c="orange.8" role="alert" className={styles.notice}>
            {readFailed.title} {readFailed.detail || ''} {readFailed.next || ''}
          </Text>
        ) : null}
        {news.data?.seeded ? (
          <Text size="xs" c="dimmed" className={styles.notice}>
            First scan seeded. Everything already present was marked acknowledged, so nothing
            pre-existing shows here as new.
          </Text>
        ) : null}
        {advanced ? (
          <div className={styles.head} aria-hidden="true">
            <span />
            <span>Model</span>
            <span>State</span>
            <span>Context · output</span>
            <span>Alias</span>
            <span>Acknowledge · disable</span>
          </div>
        ) : null}
        {!advanced
          ? BUCKETS.map((item) => {
              const members = visible.filter((entry) => catalogBucket(entry) === item.id);
              if (!members.length) return null;
              return (
                <BoardGroup key={item.id} label={item.label} tone={item.tone} count={members.length}>
                  {members.map((entry) => (
                    <Card
                      key={entry.id}
                      id={entry.id}
                      bucket={item.id}
                      label={entry.id}
                      head={
                        <>
                          <ProviderMark provider={entry.provider} size="small" />
                          <div className={styles.identityText}>
                            <span className="models-name">{entry.name}</span>
                            <small className="models-id">{entry.id}</small>
                          </div>
                          <CatalogActions entry={entry} {...rowProps(entry)} />
                        </>
                      }
                      state={
                        <>
                          <StateWord tone={TONE[item.id]}>{WORD[item.id]}</StateWord>
                          <span className={styles.spacer} />
                          <AliasField
                            entry={entry}
                            disabled={Boolean(busy) || Boolean(readFailed)}
                            onCommit={(value) => commitAlias(entry, value)}
                          />
                        </>
                      }
                    >
                      <CatalogEvidence entry={entry} widest={widest} widestOutput={widestOutput} />
                    </Card>
                  ))}
                </BoardGroup>
              );
            })
          : null}
        <div className={styles.rows} hidden={!advanced}>
          {advanced
            ? visible.map((entry) => {
                const state = catalogBucket(entry);
                return (
                  <article
                    key={entry.id}
                    className={styles.row}
                    data-account-id={entry.id}
                    data-bucket={state}
                    aria-label={entry.id}
                  >
                    <div className={styles.main}>
                      <span />
                      <div className={styles.identity}>
                        <ProviderMark provider={entry.provider} size="small" />
                        <div className={styles.identityText}>
                          <span className="models-name">{entry.name}</span>
                          <small className="models-id">{entry.id}</small>
                        </div>
                      </div>
                      <div className={styles.state}>
                        <StateWord tone={TONE[state]}>{WORD[state]}</StateWord>
                      </div>
                      <div className={styles.quota}>
                        <CatalogEvidence entry={entry} widest={widest} widestOutput={widestOutput} />
                      </div>
                      <div className={styles.activity}>
                        <AliasField
                          entry={entry}
                          disabled={Boolean(busy) || Boolean(readFailed)}
                          onCommit={(value) => commitAlias(entry, value)}
                        />
                      </div>
                      <div className={styles.actions}>
                        <CatalogActions entry={entry} {...rowProps(entry)} />
                      </div>
                    </div>
                  </article>
                );
              })
            : null}
        </div>
        <div className={styles.messages}>
          {models.loading && !models.data ? (
            <div className={styles.empty}>
              <Loader size="xs" /> Reading the catalog…
            </div>
          ) : null}
          {models.data && !entries.length ? (
            <div className={styles.empty}>
              No model is available. A model appears once a provider is connected.
            </div>
          ) : null}
          {visible.length < matching.length ? (
            <div className={styles.empty}>
              Showing {fmtNum(visible.length)} of {fmtNum(matching.length)} models. Search narrows
              the list.{' '}
              <button type="button" className={styles.linkButton} onClick={() => setShowAll(true)}>
                Show every model
              </button>
            </div>
          ) : null}
          {entries.length && !visible.length ? (
            <div className={styles.empty}>
              No model matches.{' '}
              <button
                type="button"
                className={styles.linkButton}
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
      <PlansBoard advanced={advanced} density={density} combos={combos} settings={settings} />
      <FreeTierDiscovery resource={freeSync} now={now} onSynced={refresh} />
    </>
  );
}

// Plans in effect: the live `/api/combos` path, which takes effect on the next
// request. The Plans tab stages the same shape as a reviewed configuration
// version instead.
function PlansBoard({ advanced, density, combos, settings }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(null);
  const { options } = useConfiguredModels();
  const rows = combos.data?.combos || [];
  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !needle ||
      `${row.name} ${(row.models || []).join(' ')}`.toLowerCase().includes(needle)
  );
  const overrides = settings.data?.comboStrategies || {};
  const fallback = settings.data?.comboStrategy || 'fallback';
  const parse = (value) =>
    String(value || '')
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  async function run(id, request, message) {
    if (busy) return;
    setBusy(id);
    const result = await request();
    if (report(result, message, id)) combos.refresh();
    setBusy(null);
  }
  async function create(event) {
    event.preventDefault();
    const list = parse(members);
    if (!name.trim() || !list.length) {
      toast('orange', 'A plan needs a name and at least one member model.', 'Create a plan');
      return;
    }
    await run(
      name.trim(),
      () =>
        call('/api/combos', {
          method: 'POST',
          body: { name: name.trim(), kind: null, models: list },
        }),
      `Created. ${NEXT_REQUEST}`
    );
    setName('');
    setMembers('');
    setAdding(false);
  }

  return (
    <Board label="Plans in effect" advanced={advanced} density={density}>
      <BoardSummary
        label="Plan summary"
        chips={[
          { id: null, label: rows.length === 1 ? 'plan' : 'plans', count: rows.length },
          {
            id: 'override',
            tone: 'positive',
            label: 'with a strategy override',
            count: rows.filter((row) => overrides[row.name]?.fallbackStrategy).length,
          },
        ]}
        note={`Default strategy ${fallback}. Edits here take effect on the next request; the Plans tab stages a reviewed version instead.`}
      />
      <BoardToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search plans"
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Icon name="i-add" />}
              aria-expanded={adding}
              onClick={() => setAdding((value) => !value)}
            >
              Create a plan
            </Button>
            <Tooltip label="Re-read the plans in effect">
              <ActionIcon
                variant="default"
                aria-label="Refresh plans"
                loading={combos.loading}
                onClick={combos.refresh}
              >
                <Icon name="i-refresh" />
              </ActionIcon>
            </Tooltip>
          </>
        }
      />
      {adding ? (
        <form className={styles.addRow} aria-label="Create a plan" onSubmit={create}>
          <CommitText
            className={styles.addName}
            aria-label="Plan name"
            placeholder="Plan name"
            value={name}
            onCommit={setName}
          />
          <MultiSelect
            size="xs"
            className={styles.addSecret}
            aria-label="Member models in order"
            placeholder="Member models, in order"
            data={options}
            searchable
            value={parse(members)}
            onChange={(value) => setMembers(value.join(', '))}
          />
          <Button size="xs" type="submit" disabled={Boolean(busy)}>
            Create
          </Button>
          <Button size="xs" variant="default" onClick={() => setAdding(false)}>
            Close
          </Button>
        </form>
      ) : null}
      {visible.map((plan) => {
        const override = overrides[plan.name]?.fallbackStrategy;
        return (
          <article
            key={plan.id}
            className={styles.row}
            data-account-id={plan.id}
            aria-label={plan.name}
          >
            <div className="models-plan">
              <div className={styles.identityText}>
                <span className="models-id">{plan.name}</span>
                <small>
                  {override ? `Override ${override}` : `Uses the default strategy (${fallback})`}
                </small>
              </div>
              <MultiSelect
                size="xs"
                className="models-plan-members"
                aria-label={`Member models for ${plan.name}`}
                placeholder="Member models, in order"
                data={options}
                searchable
                value={plan.models || []}
                disabled={busy === plan.id}
                onChange={(value) =>
                  run(
                    plan.id,
                    () =>
                      call(`/api/combos/${encodeURIComponent(plan.id)}`, {
                        method: 'PUT',
                        body: { name: plan.name, kind: plan.kind || null, models: value },
                      }),
                    `Members saved. Rotation restarts from the first step. ${NEXT_REQUEST}`
                  )
                }
              />
              <InlineConfirm
                label={`Delete the plan ${plan.name}`}
                hint={`A client addressing "${plan.name}" is refused from its next request; each member keeps routing on its own name.`}
                verb="Delete"
                icon="i-close"
                tone="red"
                disabled={busy === plan.id}
                onConfirm={() =>
                  run(
                    plan.id,
                    () => call(`/api/combos/${encodeURIComponent(plan.id)}`, { method: 'DELETE' }),
                    'Plan deleted.'
                  )
                }
              />
            </div>
          </article>
        );
      })}
      <div className={styles.messages}>
        {combos.loading && !combos.data ? (
          <div className={styles.empty}>
            <Loader size="xs" /> Reading plans…
          </div>
        ) : null}
        {combos.data && !rows.length ? (
          <div className={styles.empty}>
            No plan is defined. A client may only address a bare model until one exists.
          </div>
        ) : null}
        {rows.length && !visible.length ? (
          <div className={styles.empty}>No plan matches this search.</div>
        ) : null}
      </div>
    </Board>
  );
}

function FreeTierDiscovery({ resource, now, onSynced }) {
  const [busy, setBusy] = useState(false);
  const data = resource.data;
  async function sync() {
    setBusy(true);
    const result = await call('/api/models/free-sync', { method: 'POST' });
    if (result.ok && result.body?.skipped)
      toast(
        'orange',
        `Not run: ${result.body.reason === 'already-running' ? 'a sync is already running.' : result.body.reason}`,
        'Free-tier discovery'
      );
    else if (
      report(
        result,
        `Synced. +${fmtNum(result.body?.added || 0)} / -${fmtNum(result.body?.removed || 0)} across ${fmtNum(Object.keys(result.body?.providers || {}).length)} providers.`,
        'Free-tier discovery'
      )
    )
      onSynced();
    resource.refresh();
    setBusy(false);
  }
  return (
    <section className="models-section" aria-labelledby="free-tier-discovery">
      <div className="models-section-head">
        <h2 id="free-tier-discovery">Free-tier discovery</h2>
        <span>
          {data?.running
            ? 'Running now'
            : data?.lastRunAt
              ? `Last run ${fmtRelative(data.lastRunAt, now)}`
              : 'Not reported'}
          {data?.config?.enabled
            ? ` · every ${fmtUnit(data.config.intervalHours, 'hour')}`
            : ' · scheduler off'}
        </span>
        <span className={styles.spacer} />
        <Button size="xs" variant="default" loading={busy} onClick={sync}>
          Sync now
        </Button>
      </div>
      {data?.lastError ? (
        <p className="models-note" role="alert">
          {data.lastError}
        </p>
      ) : null}
      <div className="models-chips">
        {Object.entries(data?.providers || {}).map(([id, provider]) => (
          <span key={id} className="models-chip">
            <ProviderMark provider={id} size="small" />
            {providerIdentity(id).name} · {fmtNum(provider.count)} models
            {provider.updatedAt ? ` · ${fmtRelative(provider.updatedAt, now)}` : ''}
          </span>
        ))}
        {data && !Object.keys(data.providers || {}).length ? (
          <span className="models-note">No free-tier provider has synced yet.</span>
        ) : null}
      </div>
    </section>
  );
}

// Capability-based auto-routing sits with the other routing decisions rather
// than in the catalog, and its eligible-model pickers only offer models of
// providers that have a configured account.
export function CapabilityRouting() {
  const settings = usePoll('/api/settings', 30000);
  const [busy, setBusy] = useState(null);
  const { options } = useConfiguredModels();
  const current = settings.data;

  async function save(key, patch, message) {
    if (busy) return;
    setBusy(key);
    const result = await call('/api/settings', {
      method: 'PATCH',
      body: { capacityAdapter: buildCapacityBody(current?.capacityAdapter, key, patch) },
    });
    if (report(result, message, 'Capability routing')) settings.refresh();
    setBusy(null);
  }
  async function saveSetting(body, message) {
    setBusy('settings');
    const result = await call('/api/settings', { method: 'PATCH', body });
    if (report(result, message, 'Routing defaults')) settings.refresh();
    setBusy(null);
  }

  return (
    <section className="models-section" aria-labelledby="capability-routing">
      <div className="models-section-head">
        <h2 id="capability-routing">Capability routing and plan defaults</h2>
        <span className={styles.spacer} />
        <Tooltip label="Re-read the saved routing settings">
          <ActionIcon
            variant="default"
            aria-label="Refresh routing settings"
            loading={settings.loading}
            onClick={settings.refresh}
          >
            <Icon name="i-refresh" />
          </ActionIcon>
        </Tooltip>
      </div>
      <p className="models-note">
        The whole four-kind configuration is written on every save, because the gateway only accepts
        it as one object. {NEXT_REQUEST}
      </p>
      <div className="models-capabilities">
        {CAPABILITY_KINDS.map((kind) => {
          const config = current?.capacityAdapter?.[kind.key] || {};
          return (
            <div key={kind.key} className="models-capability" aria-label={kind.label}>
              <strong>{kind.label}</strong>
              <Switch
                size="xs"
                label="Enabled"
                checked={Boolean(config.enabled)}
                disabled={!current || busy === kind.key}
                onChange={(event) =>
                  save(kind.key, { enabled: event.currentTarget.checked }, `${kind.label} saved.`)
                }
              />
              <Switch
                size="xs"
                label="Rotate among eligible models"
                checked={Boolean(config.roundRobin)}
                disabled={!current || busy === kind.key}
                onChange={(event) =>
                  save(
                    kind.key,
                    { roundRobin: event.currentTarget.checked },
                    `${kind.label} rotation saved.`
                  )
                }
              />
              <MultiSelect
                size="xs"
                aria-label={`Eligible models for ${kind.label}`}
                placeholder="Eligible models"
                data={options}
                searchable
                value={config.models || []}
                disabled={!current || busy === kind.key}
                onChange={(value) =>
                  save(kind.key, { models: value }, `${kind.label} model list saved.`)
                }
              />
            </div>
          );
        })}
      </div>
      <div className="models-defaults">
        <Select
          size="xs"
          label="Default plan strategy"
          data={STRATEGIES}
          value={current?.comboStrategy || 'fallback'}
          disabled={!current || busy === 'settings'}
          allowDeselect={false}
          onChange={(value) =>
            value && saveSetting({ comboStrategy: value }, `Default strategy is now ${value}.`)
          }
        />
        <CommitNumber
          label="Sticky round-robin limit"
          aria-label="Sticky round-robin limit"
          min={1}
          value={current?.comboStickyRoundRobinLimit ?? 1}
          disabled={!current || busy === 'settings'}
          onCommit={(value) =>
            saveSetting(
              { comboStickyRoundRobinLimit: Number(value) || 1 },
              'Sticky round-robin limit saved.'
            )
          }
        />
        <Switch
          size="xs"
          label="Only named plans may be requested"
          checked={Boolean(current?.exposeComboOnly)}
          disabled={!current || busy === 'settings'}
          onChange={(event) =>
            saveSetting(
              { exposeComboOnly: event.currentTarget.checked },
              event.currentTarget.checked
                ? 'Only named plans may be requested.'
                : 'Bare models and plans may both be requested.'
            )
          }
        />
      </div>
    </section>
  );
}
