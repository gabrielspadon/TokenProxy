// Presentation model for the pin timeline drilldown. Pure functions only, so
// the wording of an unknown and the shape of a request URL are testable without
// a DOM. Everything absent from retention renders as a word, never as a blank
// cell and never as an invented value.

export const TIMELINE_ROOT = '/api/admin/session-pins/timeline';
export const TIMELINE_PAGE_SIZE = 25;

export const TIMELINE_KIND_LABEL = {
  request: 'Request',
  switch: 'Account switch',
  action: 'Control receipt',
};

// The filter offers the three retained sources and nothing else; an entry here
// that the backend does not accept would be refused as an unknown parameter.
export const TIMELINE_KINDS = [
  { value: '', label: 'All sources' },
  { value: 'request', label: 'Requests' },
  { value: 'switch', label: 'Account switches' },
  { value: 'action', label: 'Control receipts' },
];

export function timelineUrl({ pinId, kind = '', connectionId = '', cursor = '', pageSize } = {}) {
  const query = new URLSearchParams({ pinId });
  if (kind) query.set('kind', kind);
  if (connectionId) query.set('connectionId', connectionId);
  if (pageSize) query.set('pageSize', String(pageSize));
  if (cursor) query.set('cursor', cursor);
  return `${TIMELINE_ROOT}?${query.toString()}`;
}

// Which source a page could not join, said as a sentence rather than left for
// the operator to infer from an empty list.
export function timelineUnavailable(page) {
  return Object.entries(page?.sources || {})
    .filter(([, source]) => source && source.available === false)
    .map(([kind]) =>
      kind === 'request'
        ? 'No exact retained session join, so requests cannot be listed for this binding.'
        : `${TIMELINE_KIND_LABEL[kind] || kind} history is unavailable for this binding.`
    );
}

// Identifiers an operator can copy or search on, each labelled. A null stays
// out of the list entirely rather than rendering as "unknown identifier".
export function timelineIdentifiers(item) {
  const pairs =
    item?.kind === 'request'
      ? [
          ['Request', item.requestId],
          ['Logical request', item.logicalRequestId],
          ['Account', item.connectionId],
          ['Model', item.selectedModel],
        ]
      : item?.kind === 'switch'
        ? [
            ['Switch', item.switchId],
            ['From', item.fromConnectionId],
            ['To', item.toConnectionId],
            ['Model', item.model],
          ]
        : [
            ['Action', item.actionId],
            ['Target account', item.targetConnectionId],
            ['Model', item.model],
          ];
  return pairs
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([label, value]) => ({ label, value }));
}

// The one-line summary beside the timestamp. Each branch names its own unknown,
// and a request's served model is only ever what the row actually recorded.
export function timelineSummary(item) {
  if (item?.kind === 'request')
    return [
      `Requested ${item.requestedModel || 'Unknown'}`,
      `served ${item.servedModel || 'Not confirmed'}`,
      item.status || 'Unknown status',
    ].join(' · ');
  if (item?.kind === 'switch')
    return [
      `${item.fromConnectionId || 'First binding'} → ${item.toConnectionId || 'Unknown account'}`,
      item.trigger || 'Unknown trigger',
      item.reason || 'No reason recorded',
    ].join(' · ');
  return [
    item?.action || 'Unknown change',
    item?.status || 'Unknown state',
    item?.reason || 'No reason recorded',
    item?.appliedAt ? 'Applied' : 'Not applied',
  ].join(' · ');
}
