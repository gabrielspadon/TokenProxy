'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ECONOMICS_GROUPS } from '@/lib/db/analytics/economicsDimensions.mjs';
import { EconomicsEvidence, EconomicsCoverage } from './EconomicsEvidence';
import { Button, Checkbox, Group, Pagination, Select, Tooltip } from '@mantine/core';
import {
  columnPinningFeature, columnSizingFeature, createSortedRowModel, rowSelectionFeature,
  rowSortingFeature, sortFn_text, tableFeatures, useTable,
} from '@tanstack/react-table';
import { ProviderMark, providerIdentity } from '../ProviderMark';
import {
  TOKEN_COLUMNS, averageEstimate, averageTokens, costShare, formatCount, formatEstimate, formatPercent,
  formatTokens, groupFilters, groupKey, groupName, measuredTokens, qualityNotes, recordTime, comparisonScopeKey,
} from './economics';
import styles from './EconomicsLens.module.css';
import { EconomicsTrend } from './EconomicsTimeChart';

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

function leadColumns(columns, identities) {
  return [...identities.map(id => columns.find(column => (column.id || column.accessorKey) === id)).filter(Boolean), ...columns.filter(column => !identities.includes(column.id || column.accessorKey))];
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

function TokenComposition({ row, record = false }) {
  return <span className={styles.tokenComposition}>{TOKEN_COLUMNS.filter(column => column.id !== 'uncachedInputTokens').map(column => <span key={column.id} title={`${column.label}: ${formatCount(record ? row[column.id] : measuredTokens(row, column))} tokens. ${column.detail}`}><i aria-hidden="true" style={{ background: column.color }} /><span>{column.label}</span><strong>{formatTokens(record ? row[column.id] : measuredTokens(row, column))}</strong></span>)}</span>;
}

function DataTable({ table, label, onSelect, selectedId, rowLabel, className, stretchColumn = 'identity', populationKey = '' }) {
  const viewportRef = useRef(null);
  const [heldOrder, setHeldOrder] = useState({key:null,ids:[]});
  const rows = table.getRowModel().rows;
  const hold = Boolean(selectedId) || rows.some(row => row.getIsSelected());
  const orderKey = hold ? JSON.stringify([label,populationKey,table.getAllLeafColumns().map(column => [column.id, column.getIsSorted()])]) : null;
  if (heldOrder.key !== orderKey && (!hold || rows.length)) setHeldOrder({key:orderKey,ids:rows.map(row=>row.id)});
  const positions = new Map(heldOrder.ids.map((id,index)=>[id,index]));
  const displayRows = hold && heldOrder.key === orderKey ? rows.toSorted((a,b)=>(positions.get(a.id) ?? Infinity)-(positions.get(b.id) ?? Infinity)) : rows;
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
        <tbody>{displayRows.map((row) => (
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

function GroupBook({ data, groupBy, accounts, inspectedGroupId, onInspect, sorting, onSortingChange, onPageChange, comparison, setComparison, tokenColumns, setTokenColumns }) {
  const groups = data.groups || EMPTY;
  const summary = data.summary;
  const rowSelection = Object.fromEntries(Object.keys(comparison).map(key => [key, true]));
  const changeComparison = (updater) => {
    const selected = typeof updater === 'function' ? updater(rowSelection) : updater;
    setComparison(previous => Object.fromEntries(Object.entries(selected).filter(([, enabled]) => enabled).map(([key]) => {
      const group = groups.find(item => groupKey(item, groupBy) === key);
      return [key, previous[key] || (group ? { ...group, comparisonSnapshotAt: data.freshness?.snapshotCompletedAt ?? null } : null)];
    }).filter(([, group]) => group)));
  };
  const maximums = useMemo(() => Object.fromEntries(TOKEN_COLUMNS.map(({ id }) => [id, Math.max(0, ...groups.map((group) => group[id] || 0))])), [groups]);
  const columns = useMemo(() => [
    {
      id: 'compare', header: '', size: 38, enableSorting: false,
      cell: ({ row }) => <Checkbox size="sm" aria-label={`Compare ${groupName(row.original, groupBy, accounts)} on ${row.original.provider || 'unspecified provider'}`}
        checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />,
    },
    {
      id: 'identity', accessorFn: (group) => groupName(group, groupBy, accounts), size: 218,
      header: ECONOMICS_GROUPS.find(group=>group.value===groupBy)?.label || 'Identity', enableSorting:false,
      cell: ({ row }) => <span className={styles.identity}>{row.original.provider && <ProviderMark provider={row.original.provider} size="small" />}
        <span><strong>{groupBy === 'provider' ? providerIdentity(row.original.provider).name : groupName(row.original, groupBy, accounts)}</strong>
          <small>{groupBy === 'provider' ? 'Recorded completion ledger' : row.original.provider ? providerIdentity(row.original.provider).name : groupBy==='client-project' ? 'Client-reported, installation scoped' : 'Exact recorded identity'}</small></span>
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
      header: () => <span className={styles.columnLabel}>Recorded cost<small>USD / share of scope</small></span>,
      sortUndefined: 'last', size: 154, meta: { numeric: true },
      cell: ({ row }) => <span className={styles.estimate}><strong>{formatEstimate(row.original.recordedCostUsd)}</strong>
        <small>{formatPercent(costShare(row.original, summary))}</small></span>,
    },
    {id:'averageLatencyMs',accessorKey:'averageLatencyMs',header:()=> <span className={styles.columnLabel}>Mean latency<small>Exact linked ms / samples</small></span>,size:155,meta:{numeric:true},cell:({row})=><span className={styles.estimate}><strong>{formatCount(row.original.averageLatencyMs)}</strong><small>{formatCount(row.original.latencySamples)} samples</small></span>},
    {id:'pairedCost',header:()=> <span className={styles.columnLabel}>Cost + latency<small>USD / paired sample</small></span>,size:145,enableSorting:false,meta:{numeric:true},cell:({row})=><span className={styles.estimate}><strong>{formatEstimate(row.original.costLatencySamples>0 ? row.original.pairedCostUsd/row.original.costLatencySamples : null)}</strong><small>{formatCount(row.original.costLatencySamples)} same-row pairs</small></span>},
    {id:'tokenComposition',header:()=> <span className={styles.columnLabel}>Recorded tokens<small>Input includes cache; values are separate</small></span>,size:310,enableSorting:false,cell:({row})=><TokenComposition row={row.original}/>},
  ], [accounts, groupBy, maximums, summary]);
  const table = useTable({
    features, data: groups, columns: leadColumns(columns.filter(column => tokenColumns ? column.id !== 'tokenComposition' : ['compare','identity','recordedCostUsd','records','averageLatencyMs','tokenComposition'].includes(column.id || column.accessorKey)), ['compare', 'identity', 'recordedCostUsd', 'records', 'averageLatencyMs']), getRowId: (group) => groupKey(group, groupBy),
    initialState: { sorting: [{ id: 'recordedCostUsd', desc: true }], columnPinning: { start: ['compare', 'identity'], end: [] } },
    manualSorting:Boolean(onSortingChange), state:{rowSelection,...(sorting ? {sorting:[sorting]} : {})}, onRowSelectionChange:changeComparison,
    ...(onSortingChange ? {onSortingChange:(updater)=>{const next=typeof updater==='function'?updater([sorting]):updater;if(next[0])onSortingChange(next[0]);}} : {}),
    enableSortingRemoval: false,
  });
  const compared = Object.values(comparison);
  const selectGroup = (group) => {
    onInspect?.({ kind: 'economics-group', group, groupBy });
  };
  return (
    <>
      <div className={styles.bookTools}>
        <span>{formatCount(groups.length)} of {formatCount(data.groupPagination?.totalItems ?? groups.length)} cohorts<span className={styles.separator}>/</span>{formatCount(summary.records)} records</span>
        <Group gap={8}><Button size="compact-sm" variant="default" aria-pressed={tokenColumns} onClick={()=>setTokenColumns(value=>!value)}>{tokenColumns ? 'Show overview columns' : 'Show token columns'}</Button><Tooltip label="Identity columns remain visible when scrolling token columns."><Button size="compact-sm" variant="subtle" color="gray"
          onClick={() => table.setColumnPinning(table.getIsSomeColumnsPinned('start') ? { start: [], end: [] } : { start: ['compare', 'identity'], end: [] })}>
          {table.getIsSomeColumnsPinned('start') ? 'Unpin identity' : 'Pin identity'}</Button></Tooltip></Group>
      </div>
      <DataTable table={table} label="Economics by cohort" onSelect={selectGroup}
        selectedId={inspectedGroupId} populationKey={JSON.stringify(data.filters || {})}
        rowLabel={(group) => `Inspect ${groupName(group, groupBy, accounts)} on ${group.provider || 'unspecified provider'}`} />
      <div className={styles.tableNote}>
        <span>{tokenColumns ? 'Token rails compare each column independently. ' : 'Open token columns to sort every quantity or inspect derived uncached input. '}Select rows to compare recorded quantities.</span>
        {data.groupsTruncated ? <strong>Cohort sorting precedes pagination. Shares use the complete scope.</strong> : null}
      </div>
      {data.groupPagination?.totalPages>1 && <div className={styles.pagination}><span>Cohort page {data.groupPagination.page} of {data.groupPagination.totalPages}</span><Pagination size="sm" total={data.groupPagination.totalPages} value={data.groupPagination.page} onChange={onPageChange} disabled={!onPageChange} getItemProps={page=>({'aria-label':`Economics cohort page ${page}`})}/></div>}
      {compared.length > 0 ? <CohortComparison groups={compared} groupBy={groupBy} accounts={accounts} onClear={() => setComparison({})} /> : null}
    </>
  );
}

function CohortComparison({ groups, groupBy, accounts, onClear }) {
  const measures = [
    ['Records', (group) => formatCount(group.records)],
    ['Recorded amount (USD)', (group) => formatEstimate(group.recordedCostUsd)],
    ['Recorded USD per cost sample', (group) => formatEstimate(averageEstimate(group))],
    ['Cost samples / all records', (group) => `${formatCount(group.costSamples)} / ${formatCount(group.records)}`],
    ['Zero-cost records', (group) => formatCount(group.zeroCostRows)],
    ...TOKEN_COLUMNS.map((column) => [`${column.label} tokens / usable sample`, (group) => `${formatTokens(averageTokens(group, column))} (${formatCount(group[column.samples])} samples)`]),
  ];
  return (
    <section className={styles.comparison} aria-label="Selected cohort comparison">
      <div className={styles.sectionHeader}><h3>Selected cohorts</h3><Button size="compact-sm" variant="subtle" onClick={onClear}>Clear comparison</Button></div>
      <p>Same period and filters. Values are retained when selected, including cohorts on other pages. Clear and select again to refresh this comparison. Zero-cost records remain ambiguous.</p>
      <div className={styles.comparisonViewport} tabIndex={0} role="region" aria-label="Cohort comparison, scrollable table">
        <table className={styles.comparisonTable}><thead><tr><th scope="col">Measure / denominator</th>{groups.map((group) => (
          <th scope="col" key={groupKey(group, groupBy)}>{groupName(group, groupBy, accounts)}<small>{group.provider}</small><small>{group.comparisonSnapshotAt ? `Snapshot ${recordTime(group.comparisonSnapshotAt, true)}` : 'Snapshot time unavailable'}</small></th>
        ))}</tr></thead><tbody>{measures.map(([label, value]) => (
          <tr key={label}><th scope="row">{label}</th>{groups.map((group) => <td key={groupKey(group, groupBy)}>{value(group)}</td>)}</tr>
        ))}</tbody></table>
      </div>
    </section>
  );
}

function RequestLedger({ data, loading, error, selectedGroup, groupBy, accounts, onClear, onPageChange, onInspect, sorting, onSortingChange, status, onStatusChange, inspectedRecordId, tokenColumns, setTokenColumns }) {
  const [localSelectedId, setSelectedId] = useState(null);
  const selectedId = inspectedRecordId === undefined ? localSelectedId : inspectedRecordId;
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
      id: 'recordedCostUsd', accessorFn: (row) => row.recordedCostUsd ?? undefined, header: 'Recorded USD', size: 142,
      sortUndefined: 'last', meta: { numeric: true }, cell: ({ row }) => <span className={styles.recordCost}>{formatEstimate(row.original.recordedCostUsd)}
        {row.original.recordedCostUsd === 0 ? <small>{row.original.costSource === 'provider-reported' ? 'Upstream reported zero' : 'Zero is ambiguous'}</small> : null}</span>,
    },
    { accessorKey: 'status', header: 'Status', size: 100, enableSorting: false, cell: ({ getValue }) => <span className={styles.status} data-status={getValue()}>{getValue() === 'pending' ? 'Recorded pending' : getValue() || 'Unknown'}</span> },
    {id:'tokenComposition',header:()=> <span className={styles.columnLabel}>Recorded tokens<small>Input includes cache; values are separate</small></span>,size:310,enableSorting:false,cell:({row})=><TokenComposition row={row.original} record/>},
  ], []);
  const table = useTable({
    features, data: rows, columns: leadColumns(columns.filter(column => tokenColumns ? column.id !== 'tokenComposition' : ['timestamp','model','recordedCostUsd','status','tokenComposition'].includes(column.id || column.accessorKey)), ['timestamp', 'model', 'recordedCostUsd', 'status']), getRowId: (row) => String(row.id), enableSortingRemoval: false,
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
        <div><h3>Contributing records</h3><p>{selectedGroup ? `${groupName(selectedGroup, groupBy, accounts)}${selectedGroup.provider ? ` on ${selectedGroup.provider}` : ''}` : 'Complete selected scope'}</p></div>
        <div className={styles.ledgerControls}>
          <Button variant="default" size="compact-sm" aria-pressed={tokenColumns} onClick={()=>setTokenColumns(value=>!value)}>{tokenColumns ? 'Show record overview' : 'Show record token columns'}</Button>
          {selectedGroup ? <Button variant="subtle" size="compact-sm" onClick={onClear}>Show full scope</Button> : null}
          {onStatusChange ? <Select size="sm" w={165} styles={{ input: { fontSize: 13 } }} aria-label="Request ledger status" value={status} onChange={onStatusChange}
            allowDeselect={false} disabled={loading} data={[
              { value: 'all', label: 'All statuses' }, { value: 'succeeded', label: 'Succeeded' },
              { value: 'failed', label: 'Failed' }, { value: 'pending', label: 'Recorded pending' },
            ]} /> : null}
        </div>
      </div>
      {error ? <div role="alert" className={styles.empty}>The request ledger could not be loaded. Refresh the workspace to retry.</div>
        : loading ? <div role="status" className={styles.empty}>Loading contributing records…</div>
        : rows.length ? <DataTable table={table} label="Recorded requests" className={styles.ledgerViewport} selectedId={selectedId} stretchColumn="model" populationKey={JSON.stringify(data.filters || {})}
          rowLabel={(row) => `Inspect record ${row.id}`} onSelect={(record) => { setSelectedId(String(record.id)); onInspect?.({ kind: 'economics-record', record }); }} />
          : <div className={styles.empty}>No records match this scope. Adjust the period or filters to inspect other usage.</div>}
      <div className={styles.pagination}>
        <div>{formatCount(first)}–{formatCount(last)} of {formatCount(pagination?.totalItems ?? 0)} records<small>Sorting and status filters apply to the complete contributing ledger.</small></div>
        {pagination?.totalPages > 1 ? <Pagination size="sm" value={pagination.page} total={pagination.totalPages} onChange={onPageChange}
          disabled={loading || !onPageChange} siblings={1} boundaries={1} getControlProps={(control) => ({ 'aria-label': `${control} request ledger page` })} getItemProps={(page) => ({ 'aria-label': `Request ledger page ${page}` })} /> : null}
      </div>
    </section>
  );
}

export function EconomicsDetail({ selection, accounts = EMPTY, onDrilldown, onContext }) {
  const record = selection?.kind === 'economics-record';
  const row = record ? selection.record : selection?.kind === 'economics-group' ? selection.group : null;
  if (!row) return <p className={styles.detailHint}>Select a cohort or request to inspect its recorded quantities and coverage.</p>;
  if (record) return <EconomicsEvidence row={row} onDrilldown={onDrilldown} onContext={onContext}/>;
  return (
    <div className={styles.detail}>
      <div className={styles.detailIdentity}><ProviderMark provider={row.provider} label />
        <h3>{record ? row.model || 'Unspecified model' : groupName(row, selection.groupBy, accounts)}</h3>
        <p>{record ? recordTime(row.timestamp, true) : `${formatCount(row.records)} records in the selected scope`}</p>
        {record ? <dl className={styles.recordFacts}><div><dt>Record ID</dt><dd>{row.id}</dd></div><div><dt>Account ID</dt><dd>{row.connectionId || 'Unassigned'}</dd></div><div><dt>Status</dt><dd>{row.status === 'pending' ? 'Recorded pending' : row.status || 'Unknown'}</dd></div></dl> : null}
        {!record && selection.groupBy === 'account' ? <dl className={styles.recordFacts}><div><dt>Account ID</dt><dd>{row.connectionId || 'Unassigned'}</dd></div></dl> : null}
        {!record && !groupFilters(row, selection.groupBy) ? <p className={styles.detailNote}>This cohort has an unspecified identity. The current filter API cannot isolate its request records.</p> : null}
        {groupFilters(row, selection.groupBy) && onDrilldown && <Button variant="light" mt="sm" onClick={()=>onDrilldown(selection.groupBy,row)}>Filter contributing ledger to this cohort</Button>}
        <p className={styles.detailNote}>Inspecting this cohort preserves the surrounding population. The filter action changes which completion records contribute to the ledger.</p>
      </div>
      <div><dl className={styles.facts}>
        {TOKEN_COLUMNS.map((column) => <div key={column.id}><dt>{column.label}<small>{column.detail}</small></dt><dd>{formatCount(record ? row[column.id] : measuredTokens(row, column))}<small>{record ? 'tokens' : `tokens / ${formatCount(row[column.samples])} usable samples`}</small></dd></div>)}
      </dl>
      <p className={styles.detailNote}>Input is cache inclusive. Uncached input is derived from input minus cache reads and writes, clamped at zero.</p></div>
      <div><dl className={styles.facts}>
        <div className={styles.costFact}><dt>Chosen ledger amount<small>Read the contributing cost sources</small></dt><dd>{formatEstimate(row.recordedCostUsd)}<small>USD</small></dd></div>
        <div><dt>Application estimates</dt><dd>{formatEstimate(row.estimatedCostUsd)}<small>{formatCount(row.estimatedCostSamples)} samples</small></dd></div>
        <div><dt>Upstream USD reports</dt><dd>{formatEstimate(row.reportedCostUsd)}<small>{formatCount(row.reportedCostSamples)} samples</small></dd></div>
        {!record ? <><div><dt>Cost samples / all records</dt><dd>{formatCount(row.costSamples)} / {formatCount(row.records)}</dd></div>
          <div><dt>Zero-cost records</dt><dd>{formatCount(row.zeroCostRows)}</dd></div>
          <div><dt>Recorded USD / cost sample</dt><dd>{formatEstimate(averageEstimate(row))}<small>USD</small></dd></div></> : null}
      </dl>
      <QualityNotice row={row} record={record} />
      <p className={styles.detailNote}>Estimates and upstream USD reports are separate, never added together. Neither establishes subscription payments or confirmed invoice charges. Historical zero remains ambiguous.</p>
      </div>
    </div>
  );
}

export default function EconomicsLens({
  data, loading = false, error, groupBy = 'provider', onGroupByChange,
  ledgerData, ledgerLoading = false, ledgerError, selectedGroup, onGroupSelect,
  onPageChange, onInspect, accounts = EMPTY, ledgerSorting = DEFAULT_SORTING, onLedgerSortingChange,
  ledgerStatus = 'all', onLedgerStatusChange,
  inspectedRecordId, inspectedGroupId,
  onTimeRangeChange, groupSorting,onGroupSortingChange,onGroupPageChange,costSource='all',onCostSourceChange,attemptKind='all',onAttemptKindChange,
}) {
  const summary = data?.summary;
  const comparisonKey = data ? comparisonScopeKey(data.filters, groupBy) : null;
  const [comparisonState, setComparisonState] = useState({ scope: comparisonKey, groups: {} });
  const [groupTokenColumns, setGroupTokenColumns] = useState(false);
  const [ledgerTokenColumns, setLedgerTokenColumns] = useState(false);
  if (data && comparisonState.scope !== comparisonKey) setComparisonState({ scope: comparisonKey, groups: {} });
  const comparison = comparisonState.scope === comparisonKey ? comparisonState.groups : {};
  const setComparison = (updater) => setComparisonState(previous => ({ scope: comparisonKey, groups: typeof updater === 'function' ? updater(previous.scope === comparisonKey ? previous.groups : {}) : updater }));
  return (
    <section className={styles.lens} aria-label="Token economics" aria-busy={loading}>
      <div className={styles.heading}>
        <div><h2>Recorded token economics</h2><p>Completion quantities, application estimates and upstream USD reports</p></div>
        <Group gap="xs" wrap="wrap"><Select size="sm" w={210} value={groupBy} onChange={onGroupByChange} disabled={!onGroupByChange || loading} allowDeselect={false} aria-label="Group economics by" data={ECONOMICS_GROUPS.map(({value,label})=>({value,label}))}/>
          {onCostSourceChange && <Select size="sm" w={180} aria-label="Cost evidence source" allowDeselect={false} value={costSource} onChange={onCostSourceChange} data={[{value:'all',label:'All cost sources'},{value:'application-estimate',label:'Application estimates'},{value:'provider-reported',label:'Upstream USD reports'},{value:'unknown',label:'Unknown cost source'}]}/>}
          {onAttemptKindChange && <Select size="sm" w={175} aria-label="Physical attempt kind" allowDeselect={false} value={attemptKind} onChange={onAttemptKindChange} data={[{value:'all',label:'All attempt coverage'},{value:'initial',label:'Initial physical attempts'},{value:'additional',label:'Additional physical attempts'},{value:'unknown',label:'Unknown attempt coverage'}]}/>}
        </Group>
      </div>
      {error ? <div role="alert" className={styles.empty}>Economics could not be loaded. Refresh the workspace to retry.</div>
        : loading || !summary ? <div role="status" className={styles.empty}>Loading recorded economics…</div>
        : <>
          <div className={styles.overview}>
            <div className={styles.scopeTotal} aria-label="Selected cost population"><div className={styles.totalAmount}><span>Recorded amount</span><strong>{formatEstimate(summary.recordedCostUsd)} <small>USD</small></strong><small>Estimates and upstream reports. Confirmed invoice charges are unavailable.</small></div><div><span>Cost coverage</span><strong>{formatCount(summary.costSamples)} <small>/ {formatCount(summary.records)} records</small></strong></div><div><span>Exact request links</span><strong>{formatCount(summary.linkedRequestRows)} <small>/ {formatCount(summary.records)} records</small></strong></div><div><span>Zero-cost records</span><strong>{formatCount(summary.zeroCostRows)}</strong><small>Read their cost source</small></div></div>
            <EconomicsTrend data={data} onTimeRangeChange={onTimeRangeChange} />
          </div>
          <div className={styles.evidenceNotes}><QualityNotice row={summary} /><EconomicsCoverage summary={summary}/></div>
          {summary.records ? <GroupBook key={comparisonScopeKey(data.filters, groupBy)} data={data} groupBy={groupBy} accounts={accounts} inspectedGroupId={inspectedGroupId}
            onInspect={onInspect} sorting={groupSorting} onSortingChange={onGroupSortingChange} onPageChange={onGroupPageChange} comparison={comparison} setComparison={setComparison} tokenColumns={groupTokenColumns} setTokenColumns={setGroupTokenColumns}/>
            : <div className={styles.empty}>No economics records match this scope. Expand the period or clear a filter.</div>}
          <RequestLedger data={ledgerData ?? (selectedGroup ? null : data)} loading={ledgerLoading} error={ledgerError}
            selectedGroup={selectedGroup} groupBy={groupBy} accounts={accounts} onClear={() => onGroupSelect?.(null)}
            onPageChange={onPageChange} onInspect={onInspect} sorting={ledgerSorting} onSortingChange={onLedgerSortingChange}
            status={ledgerStatus} onStatusChange={onLedgerStatusChange} inspectedRecordId={inspectedRecordId} tokenColumns={ledgerTokenColumns} setTokenColumns={setLedgerTokenColumns} />
        </>}
    </section>
  );
}
