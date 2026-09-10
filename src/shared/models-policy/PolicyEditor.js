'use client';
import { useState } from 'react';
import {
  ActionIcon,
  Autocomplete,
  Button,
  NumberInput,
  Select,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/shared/components/Icon';
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
import { CommitText } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { useConfiguredModels } from '@/shared/workspace/useConfiguredModels';
import board from '@/shared/workspace/board.module.css';
import { aliasTarget, editPlan, removePlan, setPlanOverride, STRATEGIES } from './policyModel';
import styles from './policy.module.css';

function Member({
  id,
  model,
  index,
  account,
  accounts,
  choices,
  disabled,
  onModel,
  onAccount,
  onRemove,
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={styles.member}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <Tooltip label="Space to pick up, arrow keys to reorder">
        <ActionIcon
          ref={setActivatorNodeRef}
          size="sm"
          variant="subtle"
          disabled={disabled}
          {...attributes}
          {...listeners}
          aria-label={`Reorder member ${index + 1}`}
        >
          <Icon name="i-menu" />
        </ActionIcon>
      </Tooltip>
      <span className={styles.ordinal}>{index + 1}</span>
      <Autocomplete
        size="xs"
        aria-label={`Member ${index + 1} model`}
        value={model || ''}
        data={choices}
        onChange={onModel}
        disabled={disabled}
        placeholder="provider/model or nested plan"
      />
      <Select
        size="xs"
        aria-label={`Member ${index + 1} account`}
        placeholder="Any eligible account"
        clearable
        searchable
        data={accounts}
        value={account || null}
        onChange={onAccount}
        disabled={disabled}
      />
      <ActionIcon
        size="sm"
        variant="subtle"
        color="red"
        disabled={disabled}
        aria-label={`Remove member ${index + 1}`}
        onClick={onRemove}
      >
        <Icon name="i-close" />
      </ActionIcon>
    </div>
  );
}

function OrderedMembers({ plan, document, onChange, accounts, choices, disabled }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const ids = plan.models.map((_, index) => `${plan.id}:member:${index}`);
  const connections = document.settings.comboStrategies?.[plan.name]?.memberConnections || {};
  function binding(model, id) {
    const next = { ...connections };
    if (id) next[model] = id;
    else delete next[model];
    onChange(
      setPlanOverride(
        document,
        plan.name,
        'memberConnections',
        Object.keys(next).length ? next : undefined
      )
    );
  }
  return (
    <div>
      <div className={styles.sectionHead}>
        <h3>Declared member order</h3>
        <Button
          size="compact-xs"
          variant="light"
          disabled={disabled}
          onClick={() => onChange(editPlan(document, plan.id, { models: [...plan.models, ''] }))}
        >
          Add member
        </Button>
      </div>
      <Text size="xs" c="var(--slate)" mb="xs">
        Capability fit and round-robin can change dispatch order. This list preserves the configured
        sequence.
      </Text>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id)
            onChange(
              editPlan(document, plan.id, {
                models: arrayMove(plan.models, ids.indexOf(active.id), ids.indexOf(over.id)),
              })
            );
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {plan.models.map((model, index) => (
            <Member
              key={ids[index]}
              id={ids[index]}
              model={model}
              index={index}
              account={connections[model]}
              accounts={accounts}
              choices={choices}
              disabled={disabled}
              onModel={(value) =>
                onChange(
                  editPlan(document, plan.id, {
                    models: plan.models.map((entry, i) => (i === index ? value : entry)),
                  })
                )
              }
              onAccount={(id) => binding(model, id)}
              onRemove={() =>
                onChange(
                  editPlan(document, plan.id, { models: plan.models.filter((_, i) => i !== index) })
                )
              }
            />
          ))}
        </SortableContext>
      </DndContext>
      {!plan.models.length && (
        <Text size="xs" c="var(--ember)">
          This plan has no members. Add one before validating.
        </Text>
      )}
      {Object.keys(connections).some((model) => !plan.models.includes(model)) && (
        <div className={styles.note}>
          Bindings for members outside the current list remain recorded. Local validation determines
          whether nested members resolve.{' '}
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={disabled}
            onClick={() =>
              onChange(setPlanOverride(document, plan.name, 'memberConnections', undefined))
            }
          >
            Clear account bindings
          </Button>
        </div>
      )}
    </div>
  );
}

function Overrides({ document, plan, onChange, choices, disabled }) {
  const value = document.settings.comboStrategies?.[plan.name] || {};
  const update = (key, next) => onChange(setPlanOverride(document, plan.name, key, next));
  return (
    <div className={styles.overrideGrid}>
      <Select
        size="xs"
        label="Plan strategy"
        placeholder={`Default (${document.settings.comboStrategy || 'fallback'})`}
        clearable
        value={value.fallbackStrategy || null}
        data={STRATEGIES}
        disabled={disabled}
        onChange={(next) => update('fallbackStrategy', next || undefined)}
      />
      <Autocomplete
        size="xs"
        label="Fusion judge model"
        placeholder="Gateway default"
        value={value.judgeModel || ''}
        data={choices}
        disabled={disabled}
        onChange={(next) => update('judgeModel', next || undefined)}
      />
      {[
        ['minPanel', 'Minimum panel', null],
        ['stragglerGraceMs', 'Straggler grace', ' ms'],
        ['panelHardTimeoutMs', 'Panel hard timeout', ' ms'],
      ].map(([key, label, suffix]) => (
        <NumberInput
          key={key}
          size="xs"
          label={label}
          placeholder="Gateway default"
          min={1}
          max={2147483647}
          allowDecimal={false}
          suffix={suffix || undefined}
          value={value.fusionTuning?.[key] ?? ''}
          disabled={disabled}
          onChange={(next) => {
            const tuning = { ...value.fusionTuning };
            if (next === '') delete tuning[key];
            else tuning[key] = next;
            update('fusionTuning', Object.keys(tuning).length ? tuning : undefined);
          }}
        />
      ))}
    </div>
  );
}

const planStrategy = (document, plan) =>
  document.settings.comboStrategies?.[plan.name]?.fallbackStrategy ||
  document.settings.comboStrategy ||
  'fallback';

// `density` and `onDensity` come from the page, which reads the stored choice
// once; only the board that owns the page's single switch receives `onDensity`.
export function PolicyEditor({ document, onChange, disabled = false, accounts = [], density, onDensity }) {
  const advanced = useLevel();
  const [query, setQuery] = useState('');
  // `undefined` means nothing has been chosen yet, so the first plan opens and
  // its members are one glance away; `null` is an explicit collapse.
  const [expanded, setExpanded] = useState(undefined);
  const [error, setError] = useState(null);
  const [addingAlias, setAddingAlias] = useState(false);
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState('');
  const [aliasQuery, setAliasQuery] = useState('');
  const { options } = useConfiguredModels();
  const choices = [...new Set([...options, ...document.combos.map((plan) => plan.name)])].filter(
    Boolean
  );

  const accountOptions = accounts.map((account) => ({
    value: account.connectionId,
    label: account.displayName || account.connectionId,
  }));
  for (const override of Object.values(document.settings.comboStrategies || {}))
    for (const id of Object.values(override.memberConnections || {}))
      if (id && !accountOptions.some((option) => option.value === id))
        accountOptions.push({ value: id, label: `${id} (not configured)` });

  const change = (id, patch) => {
    try {
      onChange(editPlan(document, id, patch));
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  };
  const setting = (key, value) => {
    const next = structuredClone(document);
    if (value === undefined) delete next.settings[key];
    else next.settings[key] = value;
    onChange(next);
  };
  function addPlan() {
    const id = crypto.randomUUID();
    let name = 'new-plan';
    let number = 2;
    while (document.combos.some((item) => item.name === name)) name = `new-plan-${number++}`;
    onChange({ ...document, combos: [...document.combos, { id, name, kind: null, models: [] }] });
    setExpanded(id);
  }

  const active = expanded === undefined ? (document.combos[0]?.id ?? null) : expanded;
  const needle = query.trim().toLowerCase();
  const plans = document.combos.filter(
    (plan) =>
      !needle || `${plan.name} ${(plan.models || []).join(' ')}`.toLowerCase().includes(needle)
  );
  const overridden = document.combos.filter(
    (plan) => document.settings.comboStrategies?.[plan.name]?.fallbackStrategy
  ).length;
  const aliasNames = Object.keys(document.aliases).filter(
    (name) =>
      !aliasQuery.trim() ||
      `${name} ${aliasTarget(document.aliases[name])}`
        .toLowerCase()
        .includes(aliasQuery.trim().toLowerCase())
  );

  const planDetail = (plan) => (
    <div className={styles.planDetail}>
      <OrderedMembers
        plan={{ ...plan, models: Array.isArray(plan.models) ? plan.models : [] }}
        document={document}
        onChange={onChange}
        accounts={accountOptions}
        choices={choices}
        disabled={disabled}
      />
      <Overrides
        document={document}
        plan={plan}
        onChange={onChange}
        choices={choices}
        disabled={disabled}
      />
    </div>
  );

  const planEvidence = (plan) =>
    (Array.isArray(plan.models) ? plan.models : [])
      .slice(0, 4)
      .map((model, index) => (
        <EvidenceLine
          key={`${plan.id}:${index}`}
          label={`${index + 1}`}
          unknown
          value={model || 'Not set'}
          note={document.settings.comboStrategies?.[plan.name]?.memberConnections?.[model] || ''}
          title={`Member ${index + 1} of ${plan.name}`}
        />
      ));

  const planHead = (plan, open) => (
    <>
      <div className={board.identityText}>
        <CommitText
          className={styles.planName}
          aria-label={`Plan name for ${plan.name || 'the unnamed plan'}`}
          value={plan.name || ''}
          disabled={disabled}
          error={error}
          onCommit={(value) => change(plan.id, { name: value })}
        />
        <small>
          {(plan.models?.length || 0) === 1 ? '1 member' : `${plan.models?.length || 0} members`}
          {plan.kind ? ` · ${plan.kind}` : ''}
        </small>
      </div>
      <InlineConfirm
        label={`Remove the plan ${plan.name}`}
        hint="Removes the plan from this draft. Nothing changes until the draft is activated."
        verb="Remove"
        icon="i-close"
        tone="red"
        disabled={disabled}
        onConfirm={() => {
          onChange(removePlan(document, plan.id));
          setExpanded(null);
        }}
      />
      <Tooltip label={open ? 'Collapse' : 'Members and overrides'}>
        <button
          type="button"
          className={board.caret}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${plan.name}`}
          onClick={() => setExpanded(open ? null : plan.id)}
        >
          <Icon name={open ? 'i-chevron-up' : 'i-chevron-down'} />
        </button>
      </Tooltip>
    </>
  );

  return (
    <div className={styles.directEditor}>
      <Board label="Routing plans" advanced={advanced} density={density}>
        <BoardSummary
          label="Plan summary"
          chips={[
            {
              id: null,
              label: document.combos.length === 1 ? 'plan' : 'plans',
              count: document.combos.length,
            },
            {
              id: 'override',
              tone: 'positive',
              label: 'with a strategy override',
              count: overridden,
            },
          ]}
          note={
            disabled
              ? 'Open or create a draft to edit these plans'
              : 'Edits stay in the draft until it is validated and activated'
          }
        />
        <BoardToolbar
          search={query}
          onSearch={setQuery}
          searchLabel="Search plans"
          actions={
            <Button
              size="xs"
              leftSection={<Icon name="i-add" />}
              disabled={disabled}
              onClick={addPlan}
            >
              Add plan
            </Button>
          }
        >
          {onDensity ? <DensitySwitch value={density} onChange={onDensity} /> : null}
        </BoardToolbar>
        {!advanced ? (
          plans.length ? (
            <BoardGroup label="Plans" tone={null} count={plans.length}>
              {plans.map((plan) => {
                const open = active === plan.id;
                return (
                  <Card
                    key={plan.id}
                    id={plan.id}
                    expanded={open}
                    label={plan.name || 'Unnamed plan'}
                    head={planHead(plan, open)}
                    state={
                      <>
                        <StateWord
                          tone={
                            document.settings.comboStrategies?.[plan.name]?.fallbackStrategy
                              ? 'positive'
                              : null
                          }
                        >
                          {planStrategy(document, plan)}
                        </StateWord>
                      </>
                    }
                    detail={planDetail(plan)}
                  >
                    {planEvidence(plan)}
                  </Card>
                );
              })}
            </BoardGroup>
          ) : null
        ) : null}
        <div className={board.rows} hidden={!advanced}>
          {advanced
            ? plans.map((plan) => {
                const open = active === plan.id;
                return (
                  <article
                    key={plan.id}
                    className={board.row}
                    data-account-id={plan.id}
                    data-expanded={open || undefined}
                    aria-label={plan.name || 'Unnamed plan'}
                  >
                    <div className={styles.planRow}>
                      <div className={board.identityText}>
                        <CommitText
                          className={styles.planName}
                          aria-label={`Plan name for ${plan.name || 'the unnamed plan'}`}
                          value={plan.name || ''}
                          disabled={disabled}
                          error={error}
                          onCommit={(value) => change(plan.id, { name: value })}
                        />
                        <small>{plan.kind || 'Unspecified kind'}</small>
                      </div>
                      <StateWord
                        tone={
                          document.settings.comboStrategies?.[plan.name]?.fallbackStrategy
                            ? 'positive'
                            : null
                        }
                      >
                        {planStrategy(document, plan)}
                      </StateWord>
                      <div className={board.quota}>{planEvidence(plan)}</div>
                      <div className={board.actions}>
                        <InlineConfirm
                          label={`Remove the plan ${plan.name}`}
                          hint="Removes the plan from this draft. Nothing changes until the draft is activated."
                          verb="Remove"
                          icon="i-close"
                          tone="red"
                          disabled={disabled}
                          onConfirm={() => {
                            onChange(removePlan(document, plan.id));
                            setExpanded(null);
                          }}
                        />
                        <Tooltip label={open ? 'Collapse' : 'Members and overrides'}>
                          <button
                            type="button"
                            className={board.caret}
                            aria-expanded={open}
                            aria-label={`${open ? 'Collapse' : 'Expand'} ${plan.name}`}
                            onClick={() => setExpanded(open ? null : plan.id)}
                          >
                            <Icon name={open ? 'i-chevron-up' : 'i-chevron-down'} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                    {open ? (
                      <div className={board.detail} role="region" aria-label="Plan details">
                        {planDetail(plan)}
                      </div>
                    ) : null}
                  </article>
                );
              })
            : null}
        </div>
        <div className={board.messages}>
          {!document.combos.length ? (
            <div className={board.empty}>
              No plan is recorded. Add one to the draft; a client can then address it as one model.
            </div>
          ) : null}
          {document.combos.length && !plans.length ? (
            <div className={board.empty}>No plan matches this search.</div>
          ) : null}
        </div>
      </Board>

      <Board label="Direct aliases" advanced={advanced} density={density}>
        <BoardSummary
          label="Alias summary"
          chips={[
            {
              id: null,
              label: Object.keys(document.aliases).length === 1 ? 'alias' : 'aliases',
              count: Object.keys(document.aliases).length,
            },
          ]}
          note="An alias targets one physical provider/model. Alias chains are not a routing capability."
        />
        <BoardToolbar
          search={aliasQuery}
          onSearch={setAliasQuery}
          searchLabel="Search aliases"
          actions={
            <Button
              size="xs"
              leftSection={<Icon name="i-add" />}
              aria-expanded={addingAlias}
              disabled={disabled}
              onClick={() => setAddingAlias((value) => !value)}
            >
              Add alias
            </Button>
          }
        />
        {addingAlias ? (
          <form
            className={board.addRow}
            aria-label="Add an alias"
            onSubmit={(event) => {
              event.preventDefault();
              if (!alias || !target || Object.hasOwn(document.aliases, alias)) return;
              onChange({ ...document, aliases: { ...document.aliases, [alias]: target } });
              setAlias('');
              setTarget('');
              setAddingAlias(false);
            }}
          >
            <CommitText
              className={board.addName}
              aria-label="New alias"
              placeholder="Short name"
              value={alias}
              disabled={disabled}
              onCommit={setAlias}
            />
            <Autocomplete
              size="xs"
              className={board.addSecret}
              aria-label="Physical target"
              placeholder="provider/model"
              data={options}
              value={target}
              disabled={disabled}
              onChange={setTarget}
            />
            <Button
              size="xs"
              type="submit"
              disabled={disabled || !alias || !target || Object.hasOwn(document.aliases, alias)}
            >
              Add alias
            </Button>
            <Button size="xs" variant="default" onClick={() => setAddingAlias(false)}>
              Close
            </Button>
          </form>
        ) : null}
        {aliasNames.map((name) => (
          <div className={styles.aliasRow} key={name}>
            <strong className={styles.mono}>{name}</strong>
            <Autocomplete
              size="xs"
              aria-label={`Target for ${name}`}
              value={aliasTarget(document.aliases[name])}
              data={options}
              disabled={disabled}
              onChange={(value) =>
                onChange({ ...document, aliases: { ...document.aliases, [name]: value } })
              }
            />
            <InlineConfirm
              label={`Remove alias ${name}`}
              hint="A client addressing this alias is refused once the draft is activated."
              verb="Remove"
              icon="i-close"
              tone="red"
              disabled={disabled}
              onConfirm={() => {
                const aliases = { ...document.aliases };
                delete aliases[name];
                onChange({ ...document, aliases });
              }}
            />
          </div>
        ))}
        <div className={board.messages}>
          {!Object.keys(document.aliases).length ? (
            <div className={board.empty}>
              No alias is recorded. Add one so a client can address a model by a short name.
            </div>
          ) : null}
          {Object.keys(document.aliases).length && !aliasNames.length ? (
            <div className={board.empty}>No alias matches this search.</div>
          ) : null}
        </div>
      </Board>

      <section className={styles.defaults} aria-labelledby="policy-defaults">
        <div className={styles.sectionHead}>
          <h2 id="policy-defaults">Routing defaults in this draft</h2>
          <Tooltip label="Account policy, disabled models, proxy settings and shaping options are preserved separately.">
            <span className={styles.subtitle}>Clearing a setting restores its gateway default</span>
          </Tooltip>
        </div>
        <div className={styles.overrideGrid}>
          <Select
            size="xs"
            label="Default plan strategy"
            value={document.settings.comboStrategy || null}
            placeholder="Gateway default (fallback)"
            data={STRATEGIES}
            clearable
            disabled={disabled}
            onChange={(value) => setting('comboStrategy', value || undefined)}
          />
          <NumberInput
            size="xs"
            label="Sticky round-robin limit"
            value={document.settings.comboStickyRoundRobinLimit ?? ''}
            placeholder="Gateway default (1)"
            min={1}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) =>
              setting('comboStickyRoundRobinLimit', value === '' ? undefined : value)
            }
          />
          <Select
            size="xs"
            label="Published model catalog"
            value={
              document.settings.exposeComboOnly === undefined
                ? null
                : String(document.settings.exposeComboOnly)
            }
            placeholder="Gateway default"
            clearable
            data={[
              { value: 'true', label: 'Plans only' },
              { value: 'false', label: 'Models and plans' },
            ]}
            disabled={disabled}
            onChange={(value) =>
              setting('exposeComboOnly', value === null ? undefined : value === 'true')
            }
          />
        </div>
      </section>
    </div>
  );
}
