// A projection of stored account policy only. No probe, secret, destination
// selection, environment lookup, or upstream-support inference occurs here.
export function accountPath(connection, pools = []) {
  const data = connection?.providerSpecificData || {};
  if (data.proxyPoolId === '__none__' || (!data.proxyPoolId && data.connectionProxyMode === 'direct'))
    return { kind: 'direct', label: 'Explicit direct', policy: 'Bypasses account, global and environment proxies.', poolId: null };
  if (data.proxyPoolId) {
    const pool = pools.find(value => value.id === data.proxyPoolId);
    if (!pool || pool.isActive !== true)
      return { kind: 'unavailable', label: pool?.name || data.proxyPoolId, policy: 'Selected pool missing or disabled. New routing is refused.', poolId: data.proxyPoolId };
    if (typeof data.strictProxy !== 'boolean')
      return { kind: 'unknown', label: pool.name, policy: 'Legacy binding has no stored strictness. Runtime must obtain a valid snapshot before routing.', poolId: pool.id };
    return { kind: 'pool', label: pool.name, policy: data.strictProxy ? 'Strict path. Failure does not permit direct fallback.' : 'Direct fallback may be used after a proxy failure.', poolId: pool.id };
  }
  if (data.connectionProxyMode === 'proxy' || data.connectionProxyEnabled === true)
    return { kind: 'legacy', label: 'Account proxy override', policy: data.strictProxy ? 'Stored strict path. URL validity and reachability are unverified.' : 'Stored proxy override. Validity, reachability and fallback outcome are unverified.', poolId: null };
  return { kind: 'inherited', label: 'Global or environment path', policy: 'No account-specific selection. The target URL and process proxy settings determine egress.', poolId: null };
}
