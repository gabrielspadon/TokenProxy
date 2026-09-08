'use client';
import { useState } from 'react';
import { ActionIcon, Button, Group, Modal, Select, Stack, Text, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { Icon } from '@/shared/components/Icon';
import { providerIdentity } from '@/shared/components/ProviderMark';
import { useWorkspace } from './WorkspaceProvider';
import styles from './workspace.module.css';
import { Investigations,SelectionEvidence } from './Investigations';

const PERIODS = [
  { value: 'all', label: 'All retained history' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'custom', label: 'Custom UTC range' },
];
const unique = (values) => [...new Set(values.filter(Boolean))];
export function ScopeBar({ analysisActions = true, showRefresh = true }) {
  const { scope, setScope, snapshot, accounts, models, refresh } = useWorkspace();
  const [customOpen, setCustomOpen] = useState(false);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [rangeError, setRangeError] = useState(null);
  const openRange = () => {
    const fieldValue = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : null;
    setStart(fieldValue(scope.start));
    setEnd(fieldValue(scope.end));
    setRangeError(null);
    setCustomOpen(true);
  };
  const providers = unique(accounts.map((account) => account.provider)).map((value) => ({
    value,
    label: providerIdentity(value).name,
  }));
  const modelOptions = unique(
    (models.data?.models || [])
      .filter((model) => !scope.provider || model.provider === scope.provider)
      .map((model) => model.model)
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
    setCustomOpen(false);
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
    <><div className={styles.scope} aria-label="Shared analysis scope">
      <div className={styles.scopeFields}>
      <Select
        className={styles.periodSelect}
        aria-label="Time range"
        data={PERIODS}
        value={scope.period}
        onChange={changePeriod}
        allowDeselect={false}
      />
      {scope.period === 'custom' && <Button variant="subtle" onClick={openRange}>Edit range</Button>}
      <span className={styles.scopeSeparator} />{populationFilters}
      {(scope.start || scope.provider || scope.model || scope.connectionId) && (
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
            })
          }
        >
          Clear
        </Button>
      )}
      </div>
      <div className={styles.scopeActions}>
      {analysisActions && <Investigations />}
      {analysisActions && <SelectionEvidence />}
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
      <Modal
        opened={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Analysis time range"
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Times use UTC. The start is inclusive and the end is exclusive.
          </Text>
          <DateTimePicker
            label="Start (UTC)"
            value={start}
            onChange={setStart}
            valueFormat="DD MMM YYYY, HH:mm"
          />
          <DateTimePicker
            label="End (UTC)"
            value={end}
            onChange={setEnd}
            valueFormat="DD MMM YYYY, HH:mm"
          />
          {rangeError && (
            <Text c="red" size="sm">
              {rangeError}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyRange}>Apply range</Button>
          </Group>
        </Stack>
      </Modal>
    </div></>
  );
}
