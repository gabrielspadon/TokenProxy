'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ActionIcon, Alert, Button, NativeSelect, TextInput, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { OperationHistoryInspector } from '@/shared/workspace/OperationHistoryInspector';
import { boardStyles as board, useDensity } from '@/shared/workspace/Board';
import shared from '@/shared/workspace/workspace.module.css';
import { parseOperationEventsQuery } from '@/lib/db/analytics/operationEventsQueries.mjs';

// Every exact-identity filter the retained query accepts. `operationId` is the
// board's own search box, so it is not repeated in the scope row.
const FIELDS = [
  ['phase', 'Phase'],
  ['source', 'Source'],
  ['actorClass', 'Actor class'],
  ['subjectKind', 'Subject kind'],
  ['subjectId', 'Subject ID'],
  ['provider', 'Provider ID'],
  ['connectionId', 'Connection ID'],
  ['start', 'Captured from'],
  ['end', 'Captured before'],
];
const PAGE_SIZES = ['10', '25', '50', '100', '200'];

function OperationScope({ search }) {
  const router = useRouter();
  const pathname = usePathname();
  const initial = Object.fromEntries(search);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState(null);
  const [density, setDensity] = useDensity();
  const [scoping, setScoping] = useState(
    FIELDS.some(([key]) => Boolean(initial[key])) || Boolean(initial.pageSize)
  );
  const filters = Object.fromEntries(
    [...search].filter(([key]) => !['event', 'page'].includes(key))
  );
  function navigate(patch) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }
  // Every scope change goes through one commit: build the query from the draft,
  // let the retained-query parser refuse it, and only then replace the URL.
  function commit(patch = {}) {
    const merged = { ...draft, ...patch };
    setDraft(merged);
    const next = new URLSearchParams();
    for (const [key] of [...FIELDS, ['operationId']])
      if (merged[key]?.trim()) next.set(key, merged[key].trim());
    if (merged.pageSize) next.set('pageSize', merged.pageSize);
    if (filters.state) next.set('state', filters.state);
    try {
      parseOperationEventsQuery(next);
    } catch (failure) {
      setError(failure.message);
      return;
    }
    setError(null);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }
  const field = (key, label) => (
    <TextInput
      key={key}
      size="xs"
      label={label}
      className={board.addName}
      maxLength={512}
      value={draft[key] || ''}
      placeholder={key === 'start' || key === 'end' ? '2026-09-07T00:00:00Z' : undefined}
      onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })}
      onBlur={() => commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Operation history</h1>
          <p>Retained operation receipts across pools, connections and client keys</p>
        </div>
        <Button component={Link} href="/dashboard/system" variant="default" size="compact-xs">
          System controls
        </Button>
      </div>
      <div className={shared.lensBody}>
        {error && (
          <Alert color="red" title="Scope was not applied" mb="xs">
            {error}
          </Alert>
        )}
        <OperationHistoryInspector
          allSubjects
          density={density}
          onDensity={setDensity}
          showDensity
          filters={filters}
          initialPage={Number(initial.page) || 1}
          initialSelectedId={initial.event ? Number(initial.event) : null}
          onViewChange={navigate}
          search={draft.operationId || ''}
          searchLabel="Search by operation id"
          onSearch={(value) => commit({ operationId: value })}
          toolbar={
            <>
              <NativeSelect
                size="xs"
                aria-label="Events per page"
                className={board.sort}
                value={draft.pageSize || '10'}
                onChange={(event) => commit({ pageSize: event.currentTarget.value })}
                data={PAGE_SIZES.map((value) => ({ value, label: `${value} per page` }))}
              />
              <Tooltip label="Filter by exact retained identity">
                <ActionIcon
                  variant={scoping ? 'light' : 'default'}
                  aria-label="Exact identity scope"
                  aria-expanded={scoping}
                  onClick={() => setScoping((value) => !value)}
                >
                  <Icon name="i-tune" />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Clear every scope field">
                <ActionIcon
                  variant="default"
                  aria-label="Reset scope"
                  onClick={() => {
                    setDraft({});
                    setError(null);
                    router.replace(pathname, { scroll: false });
                  }}
                >
                  <Icon name="i-close" />
                </ActionIcon>
              </Tooltip>
            </>
          }
          scopeRow={
            scoping ? (
              <div className={board.addRow} role="group" aria-label="Filter retained operations">
                {FIELDS.map(([key, label]) => field(key, label))}
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}

function OperationsContent() {
  const search = useSearchParams();
  return <OperationScope key={search.toString()} search={search} />;
}

export default function OperationsPage() {
  return (
    <Suspense fallback={<p>Reading operation scope</p>}>
      <OperationsContent />
    </Suspense>
  );
}
