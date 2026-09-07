'use client';
import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
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
import { aliasTarget, editPlan, removePlan, setPlanOverride, STRATEGIES } from './policyModel';
import styles from './policy.module.css';

function Member({ id, model, index, account, accounts, disabled, onModel, onAccount, onRemove }) {
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
      <TextInput
        aria-label={`Member ${index + 1} model`}
        value={model || ''}
        onChange={(event) => onModel(event.currentTarget.value)}
        disabled={disabled}
        placeholder="provider/model or nested plan"
      />
      <Select
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
function OrderedMembers({ plan, document, onChange, accounts, disabled }) {
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
          size="compact-sm"
          variant="light"
          disabled={disabled}
          onClick={() => onChange(editPlan(document, plan.id, { models: [...plan.models, ''] }))}
        >
          Add member
        </Button>
      </div>
      <Text size="sm" c="var(--slate)" mb="sm">
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
        <Text size="sm" c="var(--ember)">
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
function Overrides({ document, plan, onChange, disabled }) {
  const value = document.settings.comboStrategies?.[plan.name] || {};
  const update = (key, next) => onChange(setPlanOverride(document, plan.name, key, next));
  return (
    <div className={styles.overrideGrid}>
      <Select
        label="Plan strategy"
        placeholder={`Default (${document.settings.comboStrategy || 'fallback'})`}
        clearable
        value={value.fallbackStrategy || null}
        data={STRATEGIES}
        disabled={disabled}
        onChange={(next) => update('fallbackStrategy', next || undefined)}
      />
      <TextInput
        label="Fusion judge model"
        placeholder="Gateway default"
        value={value.judgeModel || ''}
        disabled={disabled}
        onChange={(event) => update('judgeModel', event.currentTarget.value || undefined)}
      />
      {[
        ['minPanel', 'Minimum panel', null],
        ['stragglerGraceMs', 'Straggler grace', ' ms'],
        ['panelHardTimeoutMs', 'Panel hard timeout', ' ms'],
      ].map(([key, label, suffix]) => (
        <NumberInput
          key={key}
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
export function PolicyEditor({ document, onChange, disabled = false, accounts = [] }) {
  const [selected, setSelected] = useState(null),
    [error, setError] = useState(null),
    [alias, setAlias] = useState(''),
    [target, setTarget] = useState('');
  const plan =
    document.combos.find((item) => item.id === selected) ||
    (selected === null ? document.combos[0] : null);
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
  return (
    <Tabs defaultValue="plans" keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="plans">Ordered plans ({document.combos.length})</Tabs.Tab>
        <Tabs.Tab value="aliases">Aliases ({Object.keys(document.aliases).length})</Tabs.Tab>
        <Tabs.Tab value="defaults">Routing defaults</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="plans">
        <div className={styles.editorGrid} data-empty={document.combos.length === 0 || undefined}>
          <aside className={styles.planList} aria-label="Routing plans">
            <div className={styles.sectionHead}>
              <h3>Plans</h3>
              <Button
                variant="subtle"
                size="compact-xs"
                disabled={disabled}
                onClick={() => {
                  const id = crypto.randomUUID();
                  let name = 'new-plan';
                  let number = 2;
                  while (document.combos.some((item) => item.name === name))
                    name = `new-plan-${number++}`;
                  onChange({
                    ...document,
                    combos: [...document.combos, { id, name, kind: null, models: [] }],
                  });
                  setSelected(id);
                }}
              >
                Add plan
              </Button>
            </div>
            {document.combos.map((item) => (
              <UnstyledButton
                key={item.id}
                data-active={plan?.id === item.id || undefined}
                onClick={() => setSelected(item.id)}
                className={styles.plan}
              >
                <strong>{item.name || 'Unnamed plan'}</strong>
                <span>
                  {item.models?.length || 0} members ·{' '}
                  {document.settings.comboStrategies?.[item.name]?.fallbackStrategy ||
                    document.settings.comboStrategy ||
                    'fallback'}
                </span>
              </UnstyledButton>
            ))}
            {!document.combos.length && (
              <Text size="sm" c="var(--slate)">
                No plans are recorded. A stored draft can add one.
              </Text>
            )}
          </aside>
          <div className={styles.planDetail}>
            {plan ? (
              <Stack gap="lg">
                <Group align="end">
                  <TextInput
                    label="Plan name"
                    value={plan.name || ''}
                    disabled={disabled}
                    error={error}
                    onChange={(event) => change(plan.id, { name: event.currentTarget.value })}
                  />
                  <TextInput
                    label="Kind"
                    placeholder="Unspecified"
                    value={plan.kind || ''}
                    disabled={disabled}
                    onChange={(event) =>
                      change(plan.id, { kind: event.currentTarget.value || null })
                    }
                  />
                  <Button
                    variant="subtle"
                    color="red"
                    disabled={disabled}
                    onClick={() => {
                      onChange(removePlan(document, plan.id));
                      setSelected(null);
                    }}
                  >
                    Remove plan
                  </Button>
                </Group>
                {Array.isArray(plan.models) ? (
                  <OrderedMembers
                    plan={plan}
                    document={document}
                    onChange={onChange}
                    accounts={accountOptions}
                    disabled={disabled}
                  />
                ) : (
                  <div className={styles.note}>
                    The stored member list is invalid.{' '}
                    <Button
                      variant="subtle"
                      disabled={disabled}
                      onClick={() => change(plan.id, { models: [] })}
                    >
                      Replace invalid member list
                    </Button>
                  </div>
                )}
                <Overrides
                  document={document}
                  plan={plan}
                  onChange={onChange}
                  disabled={disabled}
                />
              </Stack>
            ) : (
              <Text c="var(--slate)">Select a recorded plan or add one to the draft.</Text>
            )}
          </div>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="aliases">
        <div className={styles.panelBody}>
          <Text size="sm" c="var(--slate)" mb="md">
            Aliases target one physical provider/model. Alias chains are not a routing capability.
          </Text>
          {Object.entries(document.aliases).map(([name, value]) => (
            <div className={styles.aliasRow} key={name}>
              <strong className={styles.mono}>{name}</strong>
              <TextInput
                aria-label={`Target for ${name}`}
                value={aliasTarget(value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...document,
                    aliases: { ...document.aliases, [name]: event.currentTarget.value },
                  })
                }
              />
              <Button
                variant="subtle"
                color="red"
                disabled={disabled}
                size="compact-sm"
                aria-label={`Remove alias ${name}`}
                onClick={() => {
                  const aliases = { ...document.aliases };
                  delete aliases[name];
                  onChange({ ...document, aliases });
                }}
              >
                Remove
              </Button>
            </div>
          ))}
          <Group mt="md" align="end">
            <TextInput
              label="New alias"
              value={alias}
              onChange={(event) => setAlias(event.currentTarget.value)}
              disabled={disabled}
            />
            <TextInput
              label="Physical target"
              placeholder="provider/model"
              value={target}
              onChange={(event) => setTarget(event.currentTarget.value)}
              disabled={disabled}
            />
            <Button
              disabled={disabled || !alias || !target || Object.hasOwn(document.aliases, alias)}
              onClick={() => {
                onChange({ ...document, aliases: { ...document.aliases, [alias]: target } });
                setAlias('');
                setTarget('');
              }}
            >
              Add alias
            </Button>
          </Group>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="defaults">
        <div className={styles.panelBody}>
          <div className={styles.overrideGrid}>
            <Select
              label="Default plan strategy"
              value={document.settings.comboStrategy || null}
              placeholder="Gateway default (fallback)"
              data={STRATEGIES}
              clearable
              disabled={disabled}
              onChange={(value) => setting('comboStrategy', value || undefined)}
            />
            <NumberInput
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
          <Text size="sm" c="var(--slate)" mt="md">
            Clearing a covered setting restores its existing gateway default. Account policy,
            disabled models, proxy settings and shaping options are preserved separately.
          </Text>
        </div>
      </Tabs.Panel>
    </Tabs>
  );
}
