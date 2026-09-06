'use client';
import { Table } from '@mantine/core';
import { tableFeatures, useTable } from '@tanstack/react-table';
import styles from './context.module.css';

const FEATURES = tableFeatures({});
// The server owns order and pagination. Sorting the visible page would misstate the cohort.
export function ContextTable({ columns, rows, label, selectedId, minWidth = 780 }) {
  const table = useTable({ features: FEATURES, columns, data: rows, getRowId: (row) => String(row.id) });
  return <Table.ScrollContainer minWidth={minWidth} type="native" className={styles.tableScroll}>
    <Table stickyHeader highlightOnHover className={styles.table} aria-label={label}>
      <Table.Thead>{table.getHeaderGroups().map((group) => <Table.Tr key={group.id}>{group.headers.map((header) => <Table.Th key={header.id}><table.FlexRender header={header} /></Table.Th>)}</Table.Tr>)}</Table.Thead>
      <Table.Tbody>{table.getRowModel().rows.map((row) => <Table.Tr key={row.id} data-selected={String(selectedId) === row.id || undefined}>{row.getAllCells().map((cell) => <Table.Td key={cell.id}><table.FlexRender cell={cell} /></Table.Td>)}</Table.Tr>)}</Table.Tbody>
    </Table>
  </Table.ScrollContainer>;
}
