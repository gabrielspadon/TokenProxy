'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Group, NativeSelect, SimpleGrid, TextInput } from '@mantine/core';
import { OperationHistoryInspector } from '@/shared/workspace/OperationHistoryInspector';
import { parseOperationEventsQuery } from '@/lib/db/analytics/operationEventsQueries.mjs';

const FIELDS = [
  ['operationId', 'Operation ID'], ['phase', 'Phase'], ['source', 'Source'],
  ['actorClass', 'Actor class'], ['subjectKind', 'Subject kind'], ['subjectId', 'Subject ID'],
  ['provider', 'Provider ID'], ['connectionId', 'Connection ID'],
  ['start', 'Captured from (ISO time with UTC offset)'], ['end', 'Captured before (ISO time with UTC offset)'],
];

function OperationScope({ search }) {
  const router = useRouter();
  const pathname = usePathname();
  const initial = Object.fromEntries(search);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState(null);
  const filters = Object.fromEntries([...search].filter(([key]) => !['event', 'page'].includes(key)));
  function navigate(patch) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }
  function apply(event) {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [key] of FIELDS) if (draft[key]?.trim()) next.set(key, draft[key].trim());
    if (draft.pageSize) next.set('pageSize', draft.pageSize);
    if (filters.state) next.set('state', filters.state);
    try { parseOperationEventsQuery(next); }
    catch (failure) { setError(failure.message); return; }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }
  return <>
    <div className="screen-head"><h1>Operations</h1><Button component={Link} href="/dashboard/system" variant="default">System controls</Button></div>
    <p>Inspect retained operation receipts across pools and client keys. Reading history does not run a probe, retry an operation or change its subject.</p>
    <form onSubmit={apply} aria-label="Filter retained operations">
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="sm" mt="sm">
          {FIELDS.map(([key, label]) => <TextInput key={key} label={label} maxLength={512} value={draft[key] || ''} onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })} placeholder={key === 'start' || key === 'end' ? '2026-09-07T00:00:00Z' : undefined} />)}
          <NativeSelect label="Events per page" value={draft.pageSize || '10'} onChange={(event) => setDraft({ ...draft, pageSize: event.currentTarget.value })} data={['10', '25', '50', '100', '200']} />
        </SimpleGrid>
        <p className="caption">Leave time bounds blank for the server’s last 30 days. Times filter when an event was captured; the original occurrence time remains visible beside it.</p>
        {error && <Alert color="red" title="Scope was not applied">{error}</Alert>}
        <Group mt="sm"><Button type="submit">Apply scope</Button><Button variant="default" onClick={() => router.replace(pathname, { scroll: false })}>Reset scope</Button></Group>
    </form>
    <OperationHistoryInspector allSubjects filters={filters} initialPage={Number(initial.page) || 1} initialSelectedId={initial.event ? Number(initial.event) : null} onViewChange={navigate} />
  </>;
}
function OperationsContent() {
  const search = useSearchParams();
  return <OperationScope key={search.toString()} search={search} />;
}
export default function OperationsPage() {
  return <Suspense fallback={<p>Reading operation scope</p>}><OperationsContent /></Suspense>;
}
