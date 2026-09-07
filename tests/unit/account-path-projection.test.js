import { expect, it } from 'vitest';
import { accountPath } from '@/app/dashboard/network/accountPath';

const connection = providerSpecificData => ({ id: 'fixture-alpha', provider: 'openai', providerSpecificData });
const pool = { id: 'fixture-pool', name: 'Synthetic pool', isActive: true, strictProxy: true };

it('keeps default egress unknown and explicit direct distinct', () => {
  expect(accountPath(connection({}))).toMatchObject({ kind: 'inherited' });
  expect(accountPath(connection({ proxyPoolId: '__none__' }))).toMatchObject({ kind: 'direct' });
  expect(accountPath(connection({ connectionProxyMode: 'direct' }))).toMatchObject({ kind: 'direct' });
});
it('selected missing and disabled pools refuse rather than silently becoming direct', () => {
  expect(accountPath(connection({ proxyPoolId: pool.id }))).toMatchObject({ kind: 'unavailable' });
  expect(accountPath(connection({ proxyPoolId: pool.id }), [{ ...pool, isActive: false }])).toMatchObject({ kind: 'unavailable' });
});
it('uses the account strictness snapshot and preserves unknown legacy snapshots', () => {
  expect(accountPath(connection({ proxyPoolId: pool.id }), [pool])).toMatchObject({ kind: 'unknown' });
  expect(accountPath(connection({ proxyPoolId: pool.id, strictProxy: false }), [pool]).policy).toContain('fallback may');
  expect(accountPath(connection({ proxyPoolId: pool.id, strictProxy: true }), [pool]).policy).toContain('does not permit direct');
});
it('does not expose proxy secrets or claim reachability', () => {
  const value = accountPath(connection({ connectionProxyEnabled: true, connectionProxyUrl: 'http://user:secret@example.invalid' }));
  expect(JSON.stringify(value)).not.toContain('secret');
  expect(value.policy).toContain('unverified');
});
