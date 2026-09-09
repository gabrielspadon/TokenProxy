'use client';
import { useState } from 'react';
import { Alert, Button, Group, Select, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useResource } from '@/shared/workspace/useResource';
import { contextUrl } from './contextModel';

export function ContextProjectFilter({ scope, clientTool, value, onChange, onSnapshot }) {
  const [search, setSearch] = useState('');
  // Select mirrors a restored value into its input. That display label must
  // not become a search predicate which hides the rest of the population.
  const [debounced] = useDebouncedValue(search === value ? '' : search, 200);
  const [paging, setPaging] = useState({ search:'', page:1 });
  const page = paging.search === debounced ? paging.page : 1;
  const query = new URLSearchParams(contextUrl(scope,{clientTool,page}).split('?')[1]);
  query.set('view','projects'); query.set('projectSearch',debounced);
  if (value) query.set('projectLabel',value);
  const resource = useResource(`/api/context?${query}`,{onSnapshot,interval:0});
  const labels = (resource.data?.projects || []).map(item=>item.projectLabel);
  // A saved selection remains usable even when search, paging or retention
  // puts it outside the returned option page.
  const options = value && !labels.includes(value) ? [value,...labels] : labels;
  const pagination = resource.data?.pagination;
  return <div>
    <Group gap={4} wrap="nowrap">
      <Select aria-label="Project label filter" placeholder="All project labels" value={value} onChange={onChange}
        searchValue={search} onSearchChange={setSearch} filter={({options:items})=>items}
        data={options} searchable clearable clearButtonProps={{'aria-label':'Clear project label filter'}} loading={resource.loading} nothingFoundMessage="No matching project labels" w={180} />
      <Button size="compact-sm" variant="subtle" aria-label="Previous project labels" disabled={resource.loading || !pagination?.hasPrev} onClick={()=>setPaging({search:debounced,page:page-1})}>‹</Button>
      <Button size="compact-sm" variant="subtle" aria-label="Next project labels" disabled={resource.loading || !pagination?.hasNext} onClick={()=>setPaging({search:debounced,page:page+1})}>›</Button>
    </Group>
    {pagination && <Text size="xs" c="dimmed" role="status">{pagination.totalItems} labels · page {page} of {Math.max(1,pagination.totalPages)}</Text>}
    {resource.error && <Alert color="orange" title="Project labels unavailable">{resource.error}<Button size="compact-sm" variant="subtle" onClick={resource.refresh}>Retry labels</Button></Alert>}
  </div>;
}
