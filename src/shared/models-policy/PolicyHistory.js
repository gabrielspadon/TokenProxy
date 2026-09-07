'use client';
import { useState } from 'react';
import { Alert, Button, Group, Table, Tabs, Text } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { shortHash, utcTime } from './policyModel';
import styles from './policy.module.css';

function HistoryPage({ kind, refreshKey, onLoadDraft, onRollback, disabled }) {
  const [cursors, setCursors] = useState([null]);
  const before = cursors.at(-1);
  const result = useResource(
    `/api/admin/configuration/${kind}?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    { refreshKey }
  );
  const rows = result.data?.[kind] || [];
  return (
    <div className={styles.panelBody}>
      {result.loading && <Text role="status">Reading {kind}…</Text>}
      {result.error && (
        <Alert color="red" title="History unavailable">
          {result.error}
          <Button variant="subtle" onClick={result.refresh}>
            Retry history
          </Button>
        </Alert>
      )}
      <Table.ScrollContainer minWidth={660} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': `Scroll configuration ${kind}`, className: styles.tableViewport } }}>
        <Table striped withRowBorders aria-label={`Configuration ${kind}`}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{kind === 'drafts' ? 'Draft / revision' : 'Record'}</Table.Th>
              <Table.Th>Recorded at (UTC)</Table.Th>
              <Table.Th>Evidence</Table.Th>
              <Table.Th>Action</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td className={styles.mono}>
                  {kind === 'drafts' ? `${row.id.slice(0, 12)} · r${row.revision}` : row.id}
                </Table.Td>
                <Table.Td className={styles.mono}>
                  {utcTime(row.updatedAt || row.createdAt)}
                </Table.Td>
                <Table.Td>
                  {kind === 'receipts' ? (
                    <>
                      <strong>
                        {row.action} · {row.outcome}
                      </strong>
                      <Text size="sm" c="var(--slate)">
                        {row.details?.code ||
                          row.details?.effect ||
                          row.details?.recovery ||
                          'Recorded operation state'}
                      </Text>
                      {row.outcome === 'staged' && (
                        <Text size="sm" c="var(--ember)">
                          Completion is unknown. Do not replay automatically.
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <strong>{row.kind || 'Stored draft'}</strong>
                      <Text
                        size="sm"
                        className={styles.mono}
                        title={row.contentHash || row.baseHash}
                      >
                        {shortHash(row.contentHash || row.baseHash)}
                      </Text>
                    </>
                  )}
                </Table.Td>
                <Table.Td>
                  {kind === 'drafts' ? (
                    <Button
                      size="compact-sm"
                      variant="light"
                      disabled={disabled}
                      onClick={() => onLoadDraft(row.id)}
                    >
                      Open draft
                    </Button>
                  ) : kind === 'versions' && row.kind !== 'draft' ? (
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      disabled={disabled}
                      onClick={() => onRollback(row.id)}
                    >
                      Review restoration
                    </Button>
                  ) : row.provenance ? (
                    <Text size="sm" c="var(--slate)">
                      {row.provenance.source} · {row.provenance.actorClass}
                    </Text>
                  ) : null}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!result.loading && !result.error && rows.length === 0 && (
        <Text c="var(--slate)" py="md">
          No records on this history page.
        </Text>
      )}
      <Group justify="space-between" mt="md">
        <Text size="sm" c="var(--slate)">
          Page {cursors.length} · up to 20 records. History is append-only.
        </Text>
        <Group gap="xs">
          <Button
            variant="default"
            size="compact-sm"
            disabled={cursors.length === 1 || result.loading}
            onClick={() => setCursors((previous) => previous.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            variant="default"
            size="compact-sm"
            disabled={rows.length < 20 || result.loading}
            onClick={() => setCursors((previous) => [...previous, rows.at(-1).id])}
          >
            Older
          </Button>
        </Group>
      </Group>
    </div>
  );
}
export function PolicyHistory({initialKind = 'drafts', ...props}) {
  return (
    <Tabs defaultValue={initialKind} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="drafts">Stored drafts</Tabs.Tab>
        <Tabs.Tab value="versions">Immutable versions</Tabs.Tab>
        <Tabs.Tab value="receipts">Operation receipts</Tabs.Tab>
      </Tabs.List>
      {['drafts', 'versions', 'receipts'].map((kind) => (
        <Tabs.Panel value={kind} key={kind}>
          <HistoryPage key={`${kind}:${props.refreshKey}`} kind={kind} {...props} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
