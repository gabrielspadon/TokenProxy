'use client';
import Link from 'next/link';
import { Button, Text } from '@mantine/core';
import { useResource } from '@/shared/workspace/useResource';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { resolveAccountCapacity, resolveProviderCeiling } from '@/shared/utils/accountCapacity';
import shared from '@/shared/workspace/workspace.module.css';

export function AccountPolicyEvidence({ account }) {
  const { observeSnapshot, scope } = useWorkspace();
  const connection = useResource(`/api/providers/${encodeURIComponent(account.connectionId)}`, { onSnapshot: observeSnapshot });
  const settings = useResource('/api/settings', { onSnapshot: observeSnapshot });
  const qualification = useResource(`/api/admin/qualification/${encodeURIComponent(account.connectionId)}`, { onSnapshot: observeSnapshot });
  const pins = useResource(`/api/admin/session-pins?${new URLSearchParams({ connectionId: account.connectionId, limit: '5' })}`, { onSnapshot: observeSnapshot });
  const eligibility = useResource(scope.model ? `/api/admin/eligibility?${new URLSearchParams({ provider: account.provider, model: scope.model })}` : null, { onSnapshot: observeSnapshot });
  const value = connection.error ? null : connection.data?.connection;
  const policy = value?.providerSpecificData;
  const capacity = value ? resolveAccountCapacity(value) : null;
  const ceiling = settings.data && !settings.error ? resolveProviderCeiling(settings.data, account.provider) : undefined;
  const validation = qualification.error ? null : qualification.data?.validation;
  const modelEvidence = !eligibility.error && eligibility.data?.accounts?.find(item => item.connectionId === account.connectionId);
  return <section className={shared.detailSection} aria-label="Account policy evidence">
    <h3>Account policy and admission</h3>
    <dl className={shared.facts}>
      <dt>Exact account</dt><dd><bdi>{account.connectionId}</bdi></dd>
      <dt>Authentication type</dt><dd>{value?.authType || 'Unknown'}</dd>
      <dt>Fallback priority</dt><dd>{value?.priority ?? 'Unknown'}</dd>
      <dt>Account concurrent streams</dt><dd>{capacity === null ? 'Unknown' : capacity === 0 ? 'Explicitly ungated' : `${capacity}${value?.maxConcurrent == null ? ' (default)' : ''}`}</dd>
      <dt>Provider concurrent streams</dt><dd>{ceiling === undefined ? 'Unknown' : ceiling === null ? 'No outer ceiling configured' : ceiling}</dd>
      <dt>Explicit account model allowlist</dt><dd>{!value ? 'Unknown' : policy?.enabledModels?.length ? policy.enabledModels.join(', ') : 'No account allowlist configured'}</dd>
      <dt>Proxy pool reference</dt><dd>{!value ? 'Unknown' : policy?.proxyPoolId || 'No account pool binding'}</dd>
      <dt>Recorded credential validation</dt><dd>{validation?.ok === true ? 'Passed' : validation?.ok === false ? 'Failed' : 'Unknown'}</dd>
      <dt>Validation observation (UTC)</dt><dd>{validation?.checkedAt || 'Not recorded'}</dd>
      <dt>Selected model admission</dt><dd>{!scope.model ? 'Choose a shared model' : eligibility.error ? 'Unavailable' : modelEvidence?.localAdmission || 'Unknown'}</dd>
      <dt>Model support evidence</dt><dd>{modelEvidence?.modelSupport?.status || 'Unknown'}</dd>
    </dl>
    {modelEvidence?.reasons?.length > 0 && <ul>{modelEvidence.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>{reason.label} {reason.until ? `Until ${reason.until}.` : ''}</li>)}</ul>}
    <Text size="sm" c="dimmed">Account ceilings and the provider outer ceiling apply independently. A stored validation or allowlist does not prove current upstream entitlement. Pool readiness and request-specific constraints may alter a live selection.</Text>
    {connection.error && <Text size="sm" c="orange.8">Account settings unavailable. {connection.error}</Text>}
    <h3 style={{ marginTop: 18 }}>Retained session pins</h3>
    {pins.error ? <Text size="sm">Pin evidence unavailable. {pins.error}</Text> : pins.loading ? <Text size="sm">Reading pin evidence…</Text> : <>
      <Text size="sm">{pins.data?.pins?.length ?? 0} pins in this page{pins.data?.next ? '; additional pins remain' : ''}. Pins are routing continuity records, not active streams.</Text>
      <ul>{pins.data?.pins?.map(pin => <li key={pin.id}><bdi>{pin.model}</bdi> · {pin.isStale ? 'stale' : 'retained'}</li>)}</ul>
    </>}
    <Button component={Link} href={`/dashboard/connections/${encodeURIComponent(account.connectionId)}`} variant="light" mt="sm">Manage this exact connection</Button>
  </section>;
}
