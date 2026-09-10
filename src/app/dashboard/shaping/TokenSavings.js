'use client';
import { useState } from 'react';
import {
  ActionIcon,
  Loader,
  NativeSelect,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { UNAVAILABLE_CONTROLS } from '@/lib/shaping/runtimeSupport';
import { fmtNum } from '@/shared/format';
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
} from '@/shared/workspace/Board';
import styles from '@/shared/workspace/board.module.css';
import {
  CONFIGURATION_FIELDS,
  CONTROLS,
  CONTROL_GROUPS,
  THRESHOLDS,
  configuredState,
  controlScope,
  stageEvidence,
} from './controlCatalog';
import { ControlEvidence } from './ControlInventory';
import { CommitText } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';

export const GROUP_ICONS = {
  'Tool traffic': 'i-tools',
  History: 'i-context',
  Compression: 'i-shaping',
  Instructions: 'i-compatibility',
  'Privacy and cache': 'i-access',
};
const GROUP_PURPOSE = {
  'Tool traffic': 'Reduce repeated output and choose which tools reach the model.',
  History: 'Keep recent work intact while reducing older context.',
  Compression: 'Control local compression and its content-change permissions.',
  Instructions: 'Choose response style and treatment of historical reasoning.',
  'Privacy and cache': 'Manage private terms and cache lifetime.',
};
// The one routine saver each group offers in Everyday. Compression has none:
// every control there needs a separate content-change permission.
const ROUTINE = {
  'Tool traffic': 'rtkEnabled',
  History: 'memoryToolPruningEnabled',
  Instructions: 'cavemanEnabled',
  'Privacy and cache': 'privacyFilterEnabled',
};
const TONE = {
  on: 'positive',
  partly: 'positive',
  off: null,
  unknown: 'ember',
  attention: 'refusal',
};
const BUCKETS = [
  { id: 'on', label: 'enabled', tone: 'positive' },
  { id: 'off', label: 'disabled', tone: null },
  { id: 'measured', label: 'measured', tone: 'positive' },
  { id: 'unknown', label: 'not reported', tone: 'ember' },
];
const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'reduction', label: 'Largest reduction' },
  { value: 'records', label: 'Most stage records' },
];

// One control sits in exactly one state bucket. An enabled control with no
// connected runtime is attention, never a plain enabled.
export function controlBucket(settings, control) {
  const state = configuredState(settings, control);
  if (state === 'Unknown') return 'unknown';
  if (state === 'On') return UNAVAILABLE_CONTROLS[control.key] ? 'attention' : 'on';
  return 'off';
}
export function controlWord(settings, control) {
  const bucket = controlBucket(settings, control);
  if (bucket === 'attention') return 'On, no runtime';
  if (bucket === 'unknown') return 'Not reported';
  return bucket === 'on' ? 'On' : 'Off';
}
export function groupState(settings, group) {
  const members = CONTROLS.filter((control) => control.group === group);
  const unknown = members.some((control) => configuredState(settings, control) === 'Unknown');
  const on = members.filter((control) => configuredState(settings, control) === 'On');
  const bucket = unknown
    ? 'unknown'
    : on.some((control) => UNAVAILABLE_CONTROLS[control.key])
      ? 'attention'
      : !on.length
        ? 'off'
        : on.length === members.length
          ? 'on'
          : 'partly';
  return {
    group,
    members,
    on: on.length,
    bucket,
    word:
      bucket === 'unknown'
        ? 'Not reported'
        : bucket === 'attention'
          ? 'On, no runtime'
          : bucket === 'on'
            ? 'On'
            : bucket === 'partly'
              ? 'Partly on'
              : 'Off',
  };
}
// Chips count controls, so "measured" counts the controls whose stage carries a
// byte measurement. It overlaps the enabled and disabled chips deliberately: a
// measurement is history, not a current setting.
export function savingsSummary(settings, stageMap, controls = CONTROLS) {
  const counts = { on: 0, off: 0, unknown: 0, attention: 0, measured: 0 };
  for (const control of controls) {
    counts[controlBucket(settings, control)] += 1;
    if (stageEvidence(stageMap, control.stage).measured) counts.measured += 1;
  }
  return counts;
}
function matches(control, bucket, settings, stageMap) {
  if (!bucket) return true;
  if (bucket === 'measured') return stageEvidence(stageMap, control.stage).measured;
  if (bucket === 'on') return ['on', 'attention'].includes(controlBucket(settings, control));
  return controlBucket(settings, control) === bucket;
}

// One evidence line per stage: the composition palette carries the direction of
// the change (teal for a reduction, violet for growth) and the note carries the
// coverage. An unmeasured stage draws a hatched bar, never a zero.
// The evidence value column is narrow by design, so the line carries a compact
// byte figure and the exact number stays in the title and the Evidence table.
const compactBytes = (value) =>
  `${value > 0 ? '+' : value < 0 ? '-' : ''}${new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(value))}B`;

function StageLine({ label, evidence, largest, shared }) {
  if (evidence.records === null)
    return <span className={styles.muted}>No stage record in this period</span>;
  if (!evidence.measured)
    return (
      <EvidenceLine
        label={label}
        unknown
        value="—"
        note={
          evidence.measuredRecords === null
            ? 'coverage unknown'
            : `not measured · 0/${fmtNum(evidence.records)}`
        }
        title={`Stage ${label}: ${fmtNum(evidence.records)} records, none carrying a byte measurement. Recorded bytes are historical, never billed savings.`}
      />
    );
  return (
    <EvidenceLine
      label={label}
      shares={[
        {
          kind: evidence.delta > 0 ? 'write' : 'read',
          percent: Math.min(100, (Math.abs(evidence.delta) / largest) * 100),
        },
      ]}
      value={compactBytes(evidence.delta)}
      note={`${fmtNum(evidence.measuredRecords)}/${fmtNum(evidence.records)}`}
      title={`Stage ${label}: ${evidence.delta > 0 ? '+' : ''}${fmtNum(evidence.delta)} B over ${fmtNum(evidence.measuredRecords)} of ${fmtNum(evidence.records)} records${shared > 1 ? `, shared by ${shared} controls` : ''}. Stages overlap and are never added together.`}
    />
  );
}

function CommitList({ value, onCommit, ...props }) {
  const text = Array.isArray(value) ? value.join('\n') : '';
  const [draft, setDraft] = useState(text);
  const [seen, setSeen] = useState(text);
  if (seen !== text) {
    setSeen(text);
    setDraft(text);
  }
  return (
    <Textarea
      size="xs"
      rows={2}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft !== text) onCommit(draft === '' ? [] : draft.split('\n'));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDraft(text);
      }}
      {...props}
    />
  );
}

// Every threshold and processing level of one control, as in-place fields.
// One grid cell, so the Advanced row keeps its seven columns.
function ControlFields({ control, settings, disabled, onField }) {
  const first = CONTROLS.find((item) => item.stage === control.stage) === control;
  const thresholds = first ? THRESHOLDS.filter((field) => field.stage === control.stage) : [];
  const configuration = CONFIGURATION_FIELDS.filter((field) => field.control === control.key);
  if (!thresholds.length && !configuration.length)
    return <div className={styles.activity} aria-hidden="true" />;
  return (
    <div
      className={`${styles.activity} savings-fields`}
      role="group"
      aria-label={
        thresholds.length ? `${control.name} thresholds` : `${control.name} processing options`
      }
    >
      {thresholds.map((field) => (
        <Tooltip
          key={field.key}
          label={`${field.name} in ${field.unit}${field.nullable ? '. Blank inherits the runtime default.' : ''}`}
        >
          <CommitText
            className="savings-field"
            name={field.key}
            type="number"
            aria-label={field.name}
            min={field.min}
            max={field.max}
            step="1"
            placeholder={field.nullable ? 'Default' : field.unit}
            disabled={disabled}
            value={settings?.[field.key] ?? ''}
            onCommit={(next) => onField(field.key, next)}
          />
        </Tooltip>
      ))}
      {configuration.map((field) =>
        field.list ? (
          <Tooltip
            key={field.key}
            label={`${field.name}: one exact entry per line, up to 100 entries of 500 characters.`}
          >
            <CommitList
              className="savings-list"
              name={field.key}
              aria-label={field.name}
              disabled={disabled}
              value={settings?.[field.key]}
              onCommit={(next) => onField(field.key, next)}
            />
          </Tooltip>
        ) : (
          <Tooltip key={field.key} label={field.name}>
            <NativeSelect
              size="xs"
              className="savings-field"
              name={field.key}
              aria-label={field.name}
              disabled={disabled}
              value={settings?.[field.key] ?? ''}
              data={[
                ...(settings?.[field.key] == null ? [{ value: '', label: 'Not reported' }] : []),
                ...field.options.map((option) => ({ value: option, label: option })),
              ]}
              onChange={(event) => onField(field.key, event.currentTarget.value)}
            />
          </Tooltip>
        )
      )}
    </div>
  );
}

function ControlSwitch({ control, settings, busy, onToggle }) {
  const state = configuredState(settings, control);
  const unsupported = UNAVAILABLE_CONTROLS[control.key];
  return (
    <Tooltip label={unsupported ? `Runtime unavailable. ${unsupported}` : control.effect}>
      <Switch
        size="xs"
        aria-label={`Enable ${control.name}`}
        checked={state === 'On'}
        disabled={state === 'Unknown' || Boolean(unsupported) || busy}
        onChange={(event) => onToggle(control, event.currentTarget.checked)}
      />
    </Tooltip>
  );
}

export function TokenSavings({
  advanced,
  density,
  onDensity,
  settings,
  stageMap,
  recent,
  onToggle,
  onField,
  onNavigate,
  onRefresh,
  loading,
  unavailable,
  busy,
  pending,
  confirm,
  periodNote,
}) {
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [group, setGroup] = useState(null);
  const [sort, setSort] = useState('name');
  const [open, setOpen] = useState(null);
  const scoped = CONTROLS.filter((control) => !group || control.group === group);
  const summary = savingsSummary(settings, stageMap, scoped);
  const text = query.trim().toLowerCase();
  const visible = scoped
    .filter(
      (control) =>
        matches(control, bucket, settings, stageMap) &&
        `${control.name} ${control.purpose} ${control.technical || ''}`.toLowerCase().includes(text)
    )
    .sort((first, second) => {
      if (sort === 'reduction')
        return (
          Math.abs(stageEvidence(stageMap, second.stage).delta ?? 0) -
          Math.abs(stageEvidence(stageMap, first.stage).delta ?? 0)
        );
      if (sort === 'records')
        return (
          (stageEvidence(stageMap, second.stage).records ?? -1) -
          (stageEvidence(stageMap, first.stage).records ?? -1)
        );
      return first.name.localeCompare(second.name);
    });
  const largest = Math.max(
    1,
    ...CONTROLS.map((control) => stageEvidence(stageMap, control.stage))
      .filter((evidence) => evidence.measured)
      .map((evidence) => Math.abs(evidence.delta))
  );
  const groups = CONTROL_GROUPS.map((name) => groupState(settings, name));
  const cards = groups.filter(
    (item) =>
      (!group || item.group === group) &&
      (!bucket ||
        (bucket === 'measured'
          ? item.members.some((control) => stageEvidence(stageMap, control.stage).measured)
          : bucket === 'on'
            ? ['on', 'partly', 'attention'].includes(item.bucket)
            : item.bucket === bucket)) &&
      `${item.group} ${GROUP_PURPOSE[item.group]}`.toLowerCase().includes(text)
  );
  const cardBuckets = [
    { id: 'on', label: 'On', tone: 'positive' },
    { id: 'partly', label: 'Partly on', tone: 'positive' },
    { id: 'attention', label: 'No runtime', tone: 'refusal' },
    { id: 'off', label: 'Off', tone: null },
    { id: 'unknown', label: 'Not reported', tone: 'ember' },
  ];
  const editable = Boolean(settings) && !busy;
  const empty = !(advanced ? visible.length : cards.length);
  function reset() {
    setQuery('');
    setBucket(null);
    setGroup(null);
  }
  const detailFor = (control) =>
    pending?.control?.key === control.key ? (
      <InlineConfirm {...pending} {...confirm} />
    ) : open === control.key ? (
      <ControlEvidence
        control={control}
        settings={settings}
        stageMap={stageMap}
        recent={recent}
        onInvestigate={() => onNavigate('Profiles')}
      />
    ) : null;

  return (
    <Board
      label={advanced ? 'Token savings control panel' : 'Everyday token savings'}
      advanced={advanced}
      density={density}
      compare="none"
    >
      <BoardSummary
        label="Saved control summary"
        active={bucket}
        onPick={(next) => setBucket(next === bucket ? null : next)}
        chips={[
          { count: settings ? scoped.length : '—', label: 'controls' },
          ...BUCKETS.filter((item) => item.id !== 'unknown' || summary.unknown > 0).map((item) => ({
            ...item,
            count: settings || item.id === 'measured' ? summary[item.id] : '—',
          })),
          ...(summary.attention
            ? [{ id: 'attention', tone: 'refusal', count: summary.attention, label: 'no runtime' }]
            : []),
        ]}
        note={periodNote}
      />
      <BoardToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search savings controls"
        actions={
          <>
            <DensitySwitch value={density} onChange={onDensity} />
            <Tooltip label="Re-read saved controls and recorded measurements">
              <ActionIcon variant="default" aria-label="Refresh controls" onClick={onRefresh}>
                <Icon name="i-refresh" />
              </ActionIcon>
            </Tooltip>
          </>
        }
      >
        <div className={`${styles.providers} savings-chips`} role="group" aria-label="Category filter">
          {CONTROL_GROUPS.map((name) => (
            <Tooltip key={name} label={GROUP_PURPOSE[name]}>
              <button
                type="button"
                className={styles.fleetChip}
                aria-label={`${name} controls`}
                aria-pressed={group === name}
                onClick={() => setGroup(group === name ? null : name)}
              >
                <Icon name={GROUP_ICONS[name]} />
                {name}
              </button>
            </Tooltip>
          ))}
        </div>
        {advanced ? (
          <NativeSelect
            size="xs"
            aria-label="Sort controls"
            className={styles.sort}
            value={sort}
            data={SORTS}
            onChange={(event) => setSort(event.currentTarget.value)}
          />
        ) : null}
      </BoardToolbar>
      {advanced ? (
        <div className={styles.head} aria-hidden="true">
          <span />
          <span>Control</span>
          <span>State</span>
          <span>Recorded stage bytes</span>
          <span>Thresholds and levels</span>
          <span>Saved</span>
        </div>
      ) : null}
      {!advanced
        ? cardBuckets.map((item) => {
            const members = cards.filter((card) => card.bucket === item.id);
            if (!members.length) return null;
            return (
              <BoardGroup key={item.id} label={item.label} tone={item.tone} count={members.length}>
                {members.map((card) => {
                  const routine = CONTROLS.find((control) => control.key === ROUTINE[card.group]);
                  const stages = [
                    ...new Set(card.members.map((control) => control.stage).filter(Boolean)),
                  ].filter((stage) => stageEvidence(stageMap, stage).records !== null);
                  const expanded = open === card.group;
                  return (
                    <Card
                      key={card.group}
                      id={card.group}
                      bucket={card.bucket}
                      expanded={expanded || pending?.group === card.group}
                      label={`${card.group} controls`}
                      head={
                        <>
                          <Icon name={GROUP_ICONS[card.group]} />
                          <div className={styles.identityText}>
                            <span className={styles.nameLine}>{card.group}</span>
                            <small>{GROUP_PURPOSE[card.group]}</small>
                          </div>
                          {routine ? (
                            <span data-savings-control={routine.key}>
                              <ControlSwitch
                                control={routine}
                                settings={settings}
                                busy={!editable}
                                onToggle={onToggle}
                              />
                            </span>
                          ) : null}
                          <Tooltip label={expanded ? 'Collapse' : 'Every control in this group'}>
                            <button
                              type="button"
                              className={styles.caret}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${card.group}`}
                              onClick={() => setOpen(expanded ? null : card.group)}
                            >
                              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                            </button>
                          </Tooltip>
                        </>
                      }
                      state={
                        <>
                          <StateWord tone={TONE[card.bucket]}>{card.word}</StateWord>
                          <span className={styles.spacer} />
                          <span className={styles.cardAttempts}>
                            {settings ? `${card.on} of ${card.members.length} on` : 'Not reported'}
                          </span>
                        </>
                      }
                      detail={
                        pending?.group === card.group ? (
                          <InlineConfirm {...pending} {...confirm} />
                        ) : (
                          <div className={styles.facts}>
                            {card.members.map((control) => (
                              <div key={control.key}>
                                <StateWord tone={TONE[controlBucket(settings, control)]}>
                                  {control.name}
                                </StateWord>
                                <Text size="xs" c="dimmed">
                                  {control.purpose} {controlScope(control)}.
                                </Text>
                              </div>
                            ))}
                          </div>
                        )
                      }
                    >
                      {stages.length ? (
                        stages.map((stage) => (
                          <StageLine
                            key={stage}
                            label={CONTROLS.find((control) => control.stage === stage).name}
                            evidence={stageEvidence(stageMap, stage)}
                            largest={largest}
                            shared={CONTROLS.filter((control) => control.stage === stage).length}
                          />
                        ))
                      ) : (
                        <span className={styles.muted}>No stage record in this period</span>
                      )}
                    </Card>
                  );
                })}
              </BoardGroup>
            );
          })
        : null}
      <div className={styles.rows} hidden={!advanced}>
        {advanced
          ? visible.map((control) => {
              const evidence = stageEvidence(stageMap, control.stage);
              const expanded = open === control.key || pending?.control?.key === control.key;
              const unsupported = UNAVAILABLE_CONTROLS[control.key];
              return (
                <article
                  key={control.key}
                  className={styles.row}
                  data-savings-control={control.key}
                  data-expanded={expanded || undefined}
                  data-bucket={controlBucket(settings, control)}
                  aria-label={control.name}
                >
                  <div className={styles.main}>
                    <Tooltip label={expanded ? 'Collapse' : 'Evidence and requirements'}>
                      <button
                        type="button"
                        className={styles.caret}
                        aria-expanded={expanded}
                        aria-label={`Evidence and requirements for ${control.name}`}
                        onClick={() => setOpen(open === control.key ? null : control.key)}
                      >
                        <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                      </button>
                    </Tooltip>
                    <div className={styles.identity}>
                      <Icon name={GROUP_ICONS[control.group]} />
                      <div className={styles.identityText}>
                        <span className={styles.nameLine}>{control.name}</span>
                        <small>{control.purpose}</small>
                      </div>
                    </div>
                    <div className={styles.state}>
                      <StateWord tone={TONE[controlBucket(settings, control)]}>
                        {controlWord(settings, control)}
                      </StateWord>
                      <span className={styles.muted}>
                        {unsupported
                          ? 'Runtime unavailable'
                          : control.dependsOn && settings?.[control.dependsOn] !== true
                            ? 'Parent control is off'
                            : control.override
                              ? 'Plans can override'
                              : 'Global setting'}
                      </span>
                    </div>
                    <div className={styles.quota}>
                      <StageLine
                        label={control.stage || 'none'}
                        evidence={control.stage ? evidence : stageEvidence({}, null)}
                        largest={largest}
                        shared={
                          control.stage
                            ? CONTROLS.filter((item) => item.stage === control.stage).length
                            : 1
                        }
                      />
                    </div>
                    <ControlFields
                      control={control}
                      settings={settings}
                      disabled={!editable}
                      onField={onField}
                    />
                    <div className={styles.actions}>
                      <ControlSwitch
                        control={control}
                        settings={settings}
                        busy={!editable}
                        onToggle={onToggle}
                      />
                    </div>
                  </div>
                  {expanded ? detailFor(control) : null}
                </article>
              );
            })
          : null}
      </div>
      <div className={styles.messages}>
        {loading && !settings ? (
          <div className={styles.empty}>
            <Loader size="xs" /> Reading saved controls…
          </div>
        ) : null}
        {!settings && !loading ? (
          <div className={styles.empty}>
            Saved controls could not be read. Refresh to try again; nothing was changed.
          </div>
        ) : null}
        {unavailable ? (
          <div className={styles.empty} role="status">
            Measurements could not be refreshed. Any retained measurement above may be stale.
          </div>
        ) : null}
        {empty && settings ? (
          <div className={styles.empty}>
            No savings control matches.{' '}
            <button type="button" className={styles.linkButton} onClick={reset}>
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </Board>
  );
}
