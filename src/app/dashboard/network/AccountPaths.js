'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { useOptionalWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { accountPath } from './accountPath';

export function AccountPaths({ connections, pools }) {
  const workspace = useOptionalWorkspace();
  const [localSelectedId, setLocalSelectedId] = useState(null);
  const selectedId = workspace ? workspace.selectedRecord?.kind === 'account' ? workspace.selectedRecord.id : null : localSelectedId;
  const select = (id) => {
    const connection = connections.find(account => account.id === id);
    if (workspace) workspace.setSelectedRecord(id ? { kind: 'account', id, connectionId: id, ...(connection?.provider ? { provider: connection.provider } : {}) } : null);
    else setLocalSelectedId(id);
  };
  const selected = connections.find(connection => connection.id === selectedId);
  const path = selected ? accountPath(selected, pools) : null;
  return <section className="network-paths" aria-labelledby="network-paths-title">
    <h2 id="network-paths-title">Account paths</h2>
    <p className="caption">Stored account → proxy pool → provider policy. Opening this comparison does not test a route or change eligibility.</p>
    <SelectionDock open={Boolean(selected)} title={selected?.name || selected?.id || 'Account path'} subtitle={selected?.id} mark={selected ? <ProviderMark provider={selected.provider} /> : null} onClose={() => select(null)} height="min(620px, calc(100dvh - 240px))" closedMaxHeight="420px" detail={selected ? <div aria-label="Network path inspector" className="network-path-inspector">
      <dl className="facts"><dt>Provider</dt><dd><bdi>{selected.provider}</bdi></dd><dt>Account path</dt><dd><bdi>{path.label}</bdi></dd><dt>Failure policy</dt><dd>{path.policy}</dd><dt>Reachability</dt><dd>Not established by this configuration read.</dd><dt>Upstream model access</dt><dd>Unknown until supported evidence is recorded.</dd></dl>
      <Link href={`/dashboard/connections/${encodeURIComponent(selected.id)}`} prefetch={false}>Inspect account and change binding</Link>
    </div> : null}>
      <div className="network-path-list">
        {connections.map(connection => {
          const policy = accountPath(connection, pools);
          return <button type="button" className="network-path-row" key={connection.id} aria-pressed={selectedId === connection.id} onClick={() => select(connection.id)}>
            <span className="connection-name"><ProviderMark provider={connection.provider} />{connection.name || connection.id}</span>
            <span>{policy.label}</span><span>{connection.isActive === false ? 'Account disabled' : 'Account enabled'}</span>
          </button>;
        })}
        {!connections.length ? <p className="empty">No credentialed accounts are configured. Provider strategies below also cover virtual accounts without credentials.</p> : null}
      </div>
    </SelectionDock>
  </section>;
}
