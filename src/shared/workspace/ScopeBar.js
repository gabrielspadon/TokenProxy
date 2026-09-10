'use client';
import { useRef, useState } from 'react';
import { ActionIcon, Button, Select, Text, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { Icon } from '@/shared/components/Icon';
import { providerIdentity } from '@/shared/components/ProviderMark';
import { useWorkspace } from './WorkspaceProvider';
import styles from './workspace.module.css';
import { EvidenceExport, SavedInvestigations, ScopeSection, SelectionDetails, SelectionEvidence } from './Investigations';
import { modelsForAccounts } from './scopeOptions';

const PERIODS = [
  { value: 'all', label: 'All retained history' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'custom', label: 'Custom UTC range' },
];
const unique = (values) => [...new Set(values.filter(Boolean))];
export function ScopeBar({ analysisActions = true, showRefresh = true }) {
  const { scope, setScope, snapshot, accounts, models, refresh, selectedRecord, comparisonIds } = useWorkspace();
  // One section at a time opens under the strip. While it writes it holds the
  // strip: no other section opens and it cannot close.
  const [section, setSection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [rangeError, setRangeError] = useState(null);
  const strip = useRef(null);
  // Details of a selection that no longer exists close with it.
  const retained = analysisActions && (Boolean(selectedRecord) || comparisonIds.length > 0);
  if (section === 'selection' && !retained) setSection(null);
  const close = () => {
    const from = section;
    setSection(null);
    // Focus returns to the control that opened the section, or to its nearest
    // surviving neighbor when clearing removed that control.
    requestAnimationFrame(() => {
      const find = (name) => strip.current?.querySelector(`[data-scope-trigger="${name}"]`);
      const target = from === 'selection' ? find('selection') || find('export') : from === 'range' ? find('range') || find('period') : find(from);
      target?.focus({ preventScroll: true });
    });
  };
  const toggle = (name) => {
    if (busy) return;
    if (section === name) close();
    else setSection(name);
  };
  const openRange = () => {
    if (busy) return;
    const fieldValue = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : null;
    setStart(fieldValue(scope.start));
    setEnd(fieldValue(scope.end));
    setRangeError(null);
    setSection('range');
  };
  const providers = unique(accounts.map((account) => account.provider)).map((value) => ({
    value,
    label: providerIdentity(value).name,
  }));
  const modelOptions = unique(
    modelsForAccounts(models.data?.models || [], accounts, scope.provider).map((model) => model.model)
  );
  const accountOptions = accounts
    .filter((account) => !scope.provider || account.provider === scope.provider)
    .map((account) => ({
      value: account.connectionId,
      label: account.displayName || account.provider,
    }));
  if(scope.provider && !providers.some((item)=>item.value===scope.provider))providers.push({value:scope.provider,label:`${scope.provider} · not configured`});
  if(scope.connectionId && !accountOptions.some((item)=>item.value===scope.connectionId))accountOptions.push({value:scope.connectionId,label:`${scope.connectionId} · not in current accounts`});
  if(scope.model && !modelOptions.includes(scope.model))modelOptions.push(scope.model);
  const changePeriod = (period) => {
    if (period === 'custom') {
      openRange();
      return;
    }
    const anchor = snapshot?.capturedAt ? new Date(snapshot.capturedAt).getTime() : Date.now();
    setScope({
      period,
      start:
        period === 'all'
          ? null
          : new Date(anchor - (period === '24h' ? 86400000 : 604800000)).toISOString(),
      end: period === 'all' ? null : new Date(anchor).toISOString(),
    });
  };
  const applyRange = () => {
    const first = Date.parse(`${start?.replace(' ', 'T')}Z`),
      last = Date.parse(`${end?.replace(' ', 'T')}Z`);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first >= last) {
      setRangeError('Choose a start before the end.');
      return;
    }
    setScope({
      period: 'custom',
      start: new Date(first).toISOString(),
      end: new Date(last).toISOString(),
    });
    setRangeError(null);
    close();
  };
  const populationFilters = <>
    <Select className={styles.scopeSelect}
      aria-label="Provider filter" placeholder="All providers" data={providers} value={scope.provider} searchable clearable
      onChange={(provider) => setScope({ provider, connectionId: null, model: null })} />
    <Select className={styles.scopeSelect}
      aria-label="Account filter" placeholder="All accounts" data={accountOptions} value={scope.connectionId} searchable clearable
      onChange={(connectionId) => setScope({ connectionId })} />
    <Select className={styles.scopeSelect}
      aria-label="Model filter" placeholder="All models" data={modelOptions} value={scope.model} searchable clearable
      onChange={(model) => setScope({ model })} />
  </>;
  return (
    <><div ref={strip} className={styles.scope} role="group" aria-label="Shared analysis scope">
      <div className={styles.scopeFields}>
      <Select
        data-scope-trigger="period"
        className={styles.periodSelect}
        aria-label="Time range"
        data={PERIODS}
        value={scope.period}
        onChange={changePeriod}
        allowDeselect={false}
      />
      {scope.period === 'custom' && <Button data-scope-trigger="range" variant="subtle" aria-expanded={section === 'range'} onClick={() => (section === 'range' ? close() : openRange())}>Edit range</Button>}
      <span className={styles.scopeSeparator} />{populationFilters}
      {scope.projectId && <Button variant="light" size="compact-sm" onClick={() => setScope({ projectId: null })}
        title={`Clear exact project filter ${scope.projectId}`}>Project {scope.projectId.slice(0, 8)} ×</Button>}
      {(scope.start || scope.provider || scope.model || scope.connectionId || scope.projectId) && (
        <Button
          variant="subtle"
          color="gray"
          onClick={() =>
            setScope({
              period: 'all',
              start: null,
              end: null,
              provider: null,
              connectionId: null,
              model: null,
              projectId: null,
            })
          }
        >
          Clear
        </Button>
      )}
      </div>
      <div className={styles.scopeActions}>
      {analysisActions && <Button data-scope-trigger="saved" variant="default" size="compact-sm" aria-expanded={section === 'saved'} onClick={() => toggle('saved')}>Saved investigations</Button>}
      {analysisActions && <SelectionEvidence section={section} onToggle={toggle} />}
      {showRefresh && <Tooltip label={snapshot ? 'Re-read the isolated snapshot' : 'Refresh observations'}>
        <ActionIcon
          variant="default"
          size={36}
          aria-label="Refresh workspace data"
          onClick={refresh}
        >
          <Icon name="i-refresh" />
        </ActionIcon>
      </Tooltip>}
      </div>
    </div>
    {section === 'range' && (
      <ScopeSection label="Analysis time range" closeLabel="Close analysis time range" onClose={close}>
        <Text size="xs" c="dimmed">
          Times use UTC. The start is inclusive and the end is exclusive.
        </Text>
        <div className={styles.rangeFields}>
          <DateTimePicker
            size="xs"
            className={styles.rangeField}
            label="Start (UTC)"
            value={start}
            onChange={setStart}
            valueFormat="DD MMM YYYY, HH:mm"
          />
          <DateTimePicker
            size="xs"
            className={styles.rangeField}
            label="End (UTC)"
            value={end}
            onChange={setEnd}
            valueFormat="DD MMM YYYY, HH:mm"
          />
          <span className={styles.rangeActions}>
            <Button size="xs" onClick={applyRange}>Apply range</Button>
            <Button size="xs" variant="default" onClick={close}>
              Cancel
            </Button>
          </span>
        </div>
        {rangeError && (
          <Text size="xs" c="var(--refusal)" role="alert">
            {rangeError}
          </Text>
        )}
      </ScopeSection>
    )}
    {analysisActions && section === 'saved' && <SavedInvestigations busy={busy} setBusy={setBusy} onClose={close} />}
    {analysisActions && section === 'selection' && <SelectionDetails onClose={close} />}
    {analysisActions && section === 'export' && <EvidenceExport busy={busy} setBusy={setBusy} onClose={close} />}
    </>
  );
}
