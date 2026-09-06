'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Pagination, SegmentedControl, Select, Tooltip } from '@mantine/core';
import {
  columnPinningFeature, columnSizingFeature, createSortedRowModel, rowSelectionFeature,
  rowSortingFeature, sortFn_text, tableFeatures, useTable,
} from '@tanstack/react-table';
import { ProviderMark, providerIdentity } from '../ProviderMark';
import {
  TOKEN_COLUMNS, averageEstimate, averageTokens, costShare, formatCount, formatEstimate, formatPercent,
  formatTokens, groupFilters, groupKey, groupName, measuredTokens, qualityNotes, recordTime,
} from './economics';
import styles from './EconomicsLens.module.css';

const EMPTY = [];
const DEFAULT_SORTING = { id: 'timestamp', desc: true };
const features = tableFeatures({
  columnSizingFeature, columnPinningFeature, rowSelectionFeature, rowSortingFeature,
  sortedRowModel: createSortedRowModel(), sortFns: { text: sortFn_text },
});

function pinnedStyle(column) {
  const pinned = column.getIsPinned();
  return {
    width: column.getSize(), minWidth: column.getSize(), maxWidth: column.getSize(),
    position: pinned ? 'sticky' : undefined,
    insetInlineStart: pinned === 'start' ? column.getStart('start') : undefined,
    insetInlineEnd: pinned === 'end' ? column.getAfter('end') : undefined,
    zIndex: pinned ? 2 : undefined,
  };
}

function TokenValue({ value, maximum, color }) {
  return (
    <span className={styles.quantity} title={`${formatCount(value)} tokens`}>
      <span>{formatTokens(value)}</span>
      {maximum > 0 && Number.isFinite(value) ? (
        <span className={styles.rail} aria-hidden="true">
          <span style={{ width: `${Math.min(100, value / maximum * 100)}%`, backgroundColor: color }} />
        </span>
      ) : null}
    </span>
  );
}

function DataTable({ table, label, onSelect, selectedId, rowLabel, className, stretchColumn = 'identity' }) {
  const viewportRef = useRef(null);
  const columns = table.getAllLeafColumns();
  const setColumnSizing = table.setColumnSizing;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const baseWidth = columns.reduce((sum, column) => sum + column.columnDef.size, 0);
    const stretch = columns.find((column) => column.id === stretchColumn);
    if (!stretch) return;
    const resize = () => {
      const width = stretch.columnDef.size + Math.max(0, viewport.clientWidth - baseWidth);
      setColumnSizing((current) => current[stretchColumn] === width ? current : { ...current, [stretchColumn]: width });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [columns, setColumnSizing, stretchColumn]);
  return (
    <div ref={viewportRef} className={`${styles.tableViewport} ${className || ''}`} tabIndex={0} role="region" aria-label={`${label}, scrollable table`}>
      <table className={styles.table} style={{ width: table.getTotalSize() }} aria-label={label}>
        <colgroup>{table.getAllLeafColumns().map((column) => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>{group.headers.map((header) => {
              const direction = header.column.getIsSorted();
              return (
                <th key={header.id} scope="col" style={pinnedStyle(header.column)}
                  data-numeric={header.column.columnDef.meta?.numeric || undefined}
                  aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}>
                  {header.column.getCanSort() ? (
                    <button type="button" className={styles.sortButton} onClick={header.column.getToggleSortingHandler()}>
                      <span><table.FlexRender header={header} /></span>
                      <span className={styles.sortGlyph} aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕'}</span>
                    </button>
                  ) : <table.FlexRender header={header} />}
                </th>
              );
            })}</tr>
          ))}
        </thead>
        <tbody>{table.getRowModel().rows.map((row) => (
          <tr key={row.id} data-selected={row.id === selectedId || undefined}
            data-compared={row.getIsSelected() || undefined}
            onClick={onSelect ? (event) => {
              if (!event.target.closest('button,input,label,a')) onSelect(row.original);
            } : undefined}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id} style={pinnedStyle(cell.column)} data-numeric={cell.column.columnDef.meta?.numeric || undefined}>
                {(cell.column.id === 'identity' || cell.column.columnDef.meta?.identity) && onSelect ? (
                  <button type="button" className={styles.identityButton} onClick={() => onSelect(row.original)} title={rowLabel(row.original)}
                    aria-label={rowLabel(row.original)} aria-pressed={row.id === selectedId}>
                    <table.FlexRender cell={cell} />
                  </button>
                ) : <table.FlexRender cell={cell} />}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function QualityNotice({ row, record = false }) {
  const notes = qualityNotes(row, record);
  return notes.length ? (
    <details className={styles.quality}>
      <summary>Token detail needs interpretation <span>{notes.length} {notes.length === 1 ? 'issue' : 'issues'}</span></summary>
      <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </details>
  ) : null;
}

function GroupBook({ data, groupBy, accounts, selectedGroup, onGroupSelect, onInspect }) {
  const groups = data.groups || EMPTY;
  const summary = data.summary;
  const maximums = useMemo(() => Object.fromEntries(TOKEN_COLUMNS.map(({ id }) => [id, Math.max(0, ...groups.map((group) => group[id] || 0))])), [groups]);
  const columns = useMemo(() => [
    {
      id: 'compare', header: '', size: 38, enableSorting: false,
      cell: ({ row }) => <Checkbox size="xs" aria-label={`Compare ${groupName(row.original, groupBy, accounts)} on ${row.original.provider || 'unspecified provider'}`}
        checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />,
    },
    {
      id: 'identity', accessorFn: (group) => groupName(group, groupBy, accounts), size: 218,
      header: groupBy === 'model' ? 'Model / provider' : groupBy === 'account' ? 'Account / provider' : 'Provider', sortFn: 'text',
      cell: ({ row }) => <span className={styles.identity}><ProviderMark provider={row.original.provider} size="small" />
        <span><strong>{groupBy === 'provider' ? providerIdentity(row.original.provider).name : groupName(row.original, groupBy, accounts)}</strong>
          <small>{groupBy === 'provider' ? 'Recorded completion ledger' : providerIdentity(row.original.provider).name}</small></span>
      </span>,
    },
    { accessorKey: 'records', header: 'Records', size: 86, meta: { numeric: true }, cell: ({ getValue }) => formatCount(getValue()) },
    ...TOKEN_COLUMNS.map((column) => ({
      id: column.id, accessorFn: (group) => measuredTokens(group, column) ?? undefined,
      sortUndefined: 'last', size: 124, meta: { numeric: true },
      header: () => <span className={styles.columnLabel}>{column.label}<small>{column.detail}</small></span>,
      cell: ({ getValue }) => <TokenValue value={getValue()} maximum={maximums[column.id]} color={column.color} />,
    })),
    {
      id: 'recordedCostUsd', accessorFn: (group) => group.recordedCostUsd ?? undefined,
      header: () => <span className={styles.columnLabel}>Estimate<small>USD / share of scope</small></span>,
      sortUndefined: 'last', size: 154, meta: { numeric: true },
      cell: ({ row }) => <span className={styles.estimate}><strong>{formatEstimate(row.original.recordedCostUsd)}</strong>
        <small>{formatPercent(costShare(row.original, summary))}</small></span>,
    },
  ], [accounts, groupBy, maximums, summary]);
  const table = useTable({
    features, data: groups, columns, getRowId: (group) => groupKey(group, groupBy),
    initialState: { sorting: [{ id: 'recordedCostUsd', desc: true }], columnPinning: { start: ['compare', 'identity'], end: [] } },
    enableSortingRemoval: false,
  });
  const compared = table.getSelectedRowModel().rows.map((row) => row.original);
  const selectGroup = (group) => {
    onInspect?.({ kind: 'economics-group', group, groupBy });
    if (groupFilters(group, groupBy)) onGroupSelect?.(group);
  };
  return (
    <>
      <div className={styles.bookTools}>
        <span>{formatCount(groups.length)} {groupBy === 'account' ? 'accounts' : `${groupBy}s`}<span className={styles.separator}>/</span>{formatCount(summary.records)} records</span>
        <Tooltip label="Identity columns remain visible when scrolling token columns."><Button size="compact-xs" variant="subtle" color="gray"
          onClick={() => table.setColumnPinning(table.getIsSomeColumnsPinned('start') ? { start: [], end: [] } : { start: ['compare', 'identity'], end: [] })}>
          {table.getIsSomeColumnsPinned('start') ? 'Unpin identity' : 'Pin identity'}</Button></Tooltip>
      </div>
      <DataTable table={table} label="Economics by cohort" onSelect={selectGroup}
        selectedId={selectedGroup ? groupKey(selectedGroup, groupBy) : null}
        rowLabel={(group) => `Inspect ${groupName(group, groupBy, accounts)} on ${group.provider || 'unspecified provider'}`} />
      <div className={styles.tableNote}>
        <span>Token rails compare each column independently. Select rows to compare recorded quantities.</span>
        {data.groupsTruncated ? <strong>Showing the 100 cohorts with most records. Shares use the complete scope.</strong> : null}
      </div>
      {compared.length > 0 ? <CohortComparison groups={compared} groupBy={groupBy} accounts={accounts} onClear={() => table.resetRowSelection(true)} /> : null}
    </>
  );
}

function CohortComparison({ groups, groupBy, accounts, onClear }) {
  const measures = [
    ['Records', (group) => formatCount(group.records)],
    ['Recorded estimate (USD)', (group) => formatEstimate(group.recordedCostUsd)],
    ['Estimate per cost sample (USD)', (group) => formatEstimate(averageEstimate(group))],
    ['Cost samples / all records', (group) => `${formatCount(group.costSamples)} / ${formatCount(group.records)}`],
    ['Zero-cost records', (group) => formatCount(group.zeroCostRows)],
    ...TOKEN_COLUMNS.map((column) => [`${column.label} tokens / usable sample`, (group) => `${formatTokens(averageTokens(group, column))} (${formatCount(group[column.samples])} samples)`]),
  ];
  return (
    <section className={styles.comparison} aria-label="Selected cohort comparison">
      <div className={styles.sectionHeader}><h3>Selected cohorts</h3><Button size="compact-xs" variant="subtle" onClick={onClear}>Clear comparison</Button></div>
      <p>Same period and filters. Descriptive quantities; zero-cost records remain ambiguous.</p>
      <div className={styles.comparisonViewport} tabIndex={0} role="region" aria-label="Cohort comparison, scrollable table">
        <table className={styles.comparisonTable}><thead><tr><th scope="col">Measure / denominator</th>{groups.map((group) => (
          <th scope="col" key={groupKey(group, groupBy)}>{groupName(group, groupBy, accounts)}<small>{group.provider}</small></th>
        ))}</tr></thead><tbody>{measures.map(([label, value]) => (
          <tr key={label}><th scope="row">{label}</th>{groups.map((group) => <td key={groupKey(group, groupBy)}>{value(group)}</td>)}</tr>
        ))}</tbody></table>
      </div>
    </section>
  );
}

function RequestLedger({ data, loading, error, selectedGroup, groupBy, accounts, onClear, onPageChange, onInspect, sorting, onSortingChange, status, onStatusChange }) {
  const [selectedId, setSelectedId] = useState(null);
  const rows = data?.items || EMPTY;
  const columns = useMemo(() => [
    {
      accessorKey: 'timestamp', header: 'Recorded at (UTC)', size: 152, sortFn: 'text', meta: { identity: true },
      cell: ({ row }) => <span className={styles.recordIdentity}><strong>{recordTime(row.original.timestamp)}</strong><small>{row.original.id}</small></span>,
    },
    {
      accessorKey: 'model', header: 'Model / provider', size: 218, enableSorting: false,
      cell: ({ row }) => <span className={styles.identity}><ProviderMark provider={row.original.provider} size="small" />
        <span title={row.original.model || 'Unspecified model'}><strong>{row.original.model || 'Unspecified model'}</strong><small>{providerIdentity(row.original.provider).name}</small></span></span>,
    },
    ...TOKEN_COLUMNS.filter(({ id }) => id !== 'uncachedInputTokens').map(({ id, label, detail }) => ({
      accessorKey: id, header: () => <span className={styles.columnLabel}>{label}<small>{detail}</small></span>, size: 124,
      meta: { numeric: true }, cell: ({ getValue }) => <span title={`${formatCount(getValue())} tokens`}>{formatTokens(getValue())}</span>,
    })),
    {
      id: 'recordedCostUsd', accessorFn: (row) => row.recordedCostUsd ?? undefined, header: 'Estimate (USD)', size: 142,
      sortUndefined: 'last', meta: { numeric: true }, cell: ({ row }) => <span className={styles.recordCost}>{formatEstimate(row.original.recordedCostUsd)}
        {row.original.recordedCostUsd === 0 ? <small>Zero is ambiguous</small> : null}</span>,
    },
    { accessorKey: 'status', header: 'Status', size: 100, enableSorting: false, cell: ({ getValue }) => <span className={styles.status} data-status={getValue()}>{getValue() === 'pending' ? 'Recorded pending' : getValue() || 'Unknown'}</span> },
  ], []);
  const table = useTable({
    features, data: rows, columns, getRowId: (row) => String(row.id), enableSortingRemoval: false,
    manualSorting: true, enableSorting: Boolean(onSortingChange), state: { sorting: [sorting] },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater([sorting]) : updater;
      if (next[0]) onSortingChange?.(next[0]);
    },
    initialState: { columnPinning: { start: ['timestamp'], end: [] } },
  });
  const pagination = data?.pagination;
  const first = pagination?.totalItems > 0 && rows.length ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const last = pagination && rows.length ? Math.min(pagination.totalItems, pagination.page * pagination.pageSize) : 0;
  return (
    <section className={styles.ledger} aria-label="Contributing request ledger" aria-busy={loading}>
      <div className={styles.sectionHeader}>
        <div><h3>Contributing records</h3><p>{selectedGroup ? `${groupName(selectedGroup, groupBy, accounts)} on ${selectedGroup.provider}` : 'Complete selected scope'}</p></div>
        <div className={styles.ledgerControls}>
          {selectedGroup ? <Button variant="subtle" size="compact-xs" onClick={onClear}>Show full scope</Button> : null}
          {onStatusChange ? <Select size="xs" w={165} styles={{ input: { fontSize: 13 } }} aria-label="Request ledger status" value={status} onChange={onStatusChange}
            allowDeselect={false} disabled={loading} data={[
              { value: 'all', label: 'All statuses' }, { value: 'succeeded', label: 'Succeeded' },
              { value: 'failed', label: 'Failed' }, { value: 'pending', label: 'Recorded pending' },
            ]} /> : null}
        </div>
      </div>
      {error ? <div role="alert" className={styles.empty}>The request ledger could not be loaded. Refresh the workspace to retry.</div>
        : loading ? <div role="status" className={styles.empty}>Loading contributing records…</div>
        : rows.length ? <DataTable table={table} label="Recorded requests" className={styles.ledgerViewport} selectedId={selectedId} stretchColumn="model"
          rowLabel={(row) => `Inspect record ${row.id}`} onSelect={(record) => { setSelectedId(String(record.id)); onInspect?.({ kind: 'economics-record', record }); }} />
          : <div className={styles.empty}>No records match this scope. Adjust the period or filters to inspect other usage.</div>}
      <div className={styles.pagination}>
        <div>{formatCount(first)}–{formatCount(last)} of {formatCount(pagination?.totalItems ?? 0)} records<small>Sorting and status filters apply to the complete contributing ledger.</small></div>
        {pagination?.totalPages > 1 ? <Pagination size="sm" value={pagination.page} total={pagination.totalPages} onChange={onPageChange}
          disabled={loading || !onPageChange} siblings={1} boundaries={1} getItemProps={(page) => ({ 'aria-label': `Request ledger page ${page}` })} /> : null}
      </div>
    </section>
  );
}

export function EconomicsDetail({ selection, accounts = EMPTY }) {
  const record = selection?.kind === 'economics-record';
  const row = record ? selection.record : selection?.kind === 'economics-group' ? selection.group : null;
  if (!row) return <p className={styles.detailHint}>Select a cohort or request to inspect its recorded quantities and coverage.</p>;
  return (
    <div className={styles.detail}>
      <div className={styles.detailIdentity}><ProviderMark provider={row.provider} label />
        <h3>{record ? row.model || 'Unspecified model' : groupName(row, selection.groupBy, accounts)}</h3>
        <p>{record ? recordTime(row.timestamp, true) : `${formatCount(row.records)} records in the selected scope`}</p>
        {record ? <dl className={styles.recordFacts}><div><dt>Record ID</dt><dd>{row.id}</dd></div><div><dt>Account ID</dt><dd>{row.connectionId || 'Unassigned'}</dd></div><div><dt>Status</dt><dd>{row.status === 'pending' ? 'Recorded pending' : row.status || 'Unknown'}</dd></div></dl> : null}
        {!record && selection.groupBy === 'account' ? <dl className={styles.recordFacts}><div><dt>Account ID</dt><dd>{row.connectionId || 'Unassigned'}</dd></div></dl> : null}
        {record ? <p className={styles.detailNote}>No verified context-session identity is recorded in this ledger. Context attempts are not linked by timestamp.</p> : null}
        {!record && !groupFilters(row, selection.groupBy) ? <p className={styles.detailNote}>This cohort has an unspecified identity. The current filter API cannot isolate its request records.</p> : null}
      </div>
      <div><dl className={styles.facts}>
        {TOKEN_COLUMNS.map((column) => <div key={column.id}><dt>{column.label}<small>{column.detail}</small></dt><dd>{formatCount(record ? row[column.id] : measuredTokens(row, column))}<small>{record ? 'tokens' : `tokens / ${formatCount(row[column.samples])} usable samples`}</small></dd></div>)}
      </dl>
      <p className={styles.detailNote}>Input is cache inclusive. Uncached input is derived from input minus cache reads and writes, clamped at zero.</p></div>
      <div><dl className={styles.facts}>
        <div className={styles.costFact}><dt>Recorded estimate<small>Model-rate application estimate</small></dt><dd>{formatEstimate(row.recordedCostUsd)}<small>USD</small></dd></div>
        {!record ? <><div><dt>Cost samples / all records</dt><dd>{formatCount(row.costSamples)} / {formatCount(row.records)}</dd></div>
          <div><dt>Zero-cost records</dt><dd>{formatCount(row.zeroCostRows)}</dd></div>
          <div><dt>Estimate / cost sample</dt><dd>{formatEstimate(averageEstimate(row))}<small>USD</small></dd></div></> : null}
      </dl>
      <QualityNotice row={row} record={record} />
      <p className={styles.detailNote}>Recorded estimates are not subscription payments or invoices. Historical price basis is unavailable; zero does not establish free usage.</p>
      </div>
    </div>
  );
}

export default function EconomicsLens({
  data, loading = false, error, groupBy = 'provider', onGroupByChange,
  ledgerData, ledgerLoading = false, ledgerError, selectedGroup, onGroupSelect,
  onPageChange, onInspect, accounts = EMPTY, ledgerSorting = DEFAULT_SORTING, onLedgerSortingChange,
  ledgerStatus = 'all', onLedgerStatusChange,
}) {
  const summary = data?.summary;
  return (
    <section className={styles.lens} aria-label="Token economics" aria-busy={loading}>
      <div className={styles.heading}>
        <div><h2>Recorded token economics</h2><p>Completion quantities and the application’s model-rate estimates</p></div>
        <SegmentedControl size="sm" value={groupBy} onChange={onGroupByChange} disabled={!onGroupByChange || loading}
          transitionDuration={0} aria-label="Group economics by" data={[
            { value: 'provider', label: 'Provider' }, { value: 'model', label: 'Model' }, { value: 'account', label: 'Account' },
          ]} />
      </div>
      <div className={styles.provenance}>Estimates in USD, not paid spend or invoices. Historic zero costs and missing cache detail remain ambiguous.</div>
      {error ? <div role="alert" className={styles.empty}>Economics could not be loaded. Refresh the workspace to retry.</div>
        : loading || !summary ? <div role="status" className={styles.empty}>Loading recorded economics…</div>
        : <>
          <div className={styles.scopeTotal}><span>Selected scope</span><strong>{formatEstimate(summary.recordedCostUsd)} <small>estimated USD</small></strong>
            <span>{formatCount(summary.costSamples)} cost samples / {formatCount(summary.records)} records</span>
            <span>{formatCount(summary.zeroCostRows)} zero-cost records</span></div>
          <QualityNotice row={summary} />
          {summary.records ? <GroupBook key={groupBy} data={data} groupBy={groupBy} accounts={accounts} selectedGroup={selectedGroup}
            onGroupSelect={onGroupSelect} onInspect={onInspect} />
            : <div className={styles.empty}>No economics records match this scope. Expand the period or clear a filter.</div>}
          <RequestLedger data={ledgerData ?? (selectedGroup ? null : data)} loading={ledgerLoading} error={ledgerError}
            selectedGroup={selectedGroup} groupBy={groupBy} accounts={accounts} onClear={() => onGroupSelect?.(null)}
            onPageChange={onPageChange} onInspect={onInspect} sorting={ledgerSorting} onSortingChange={onLedgerSortingChange}
            status={ledgerStatus} onStatusChange={onLedgerStatusChange} />
        </>}
    </section>
  );
}
