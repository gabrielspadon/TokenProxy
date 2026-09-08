export const VERSION = 'redesign-workspace-v3';
export const CLOCK = '2026-09-07T12:00:00.000Z';
export const ACCOUNTS = Object.freeze([
  { id: 'connection-fixture-alpha', provider: 'openai', name: 'Synthetic fixture account Alpha with a deliberately long project label' },
  { id: 'connection-fixture-beta', provider: 'openai', name: 'Synthetic fixture account Beta' },
  { id: 'capacity-fixture-a', provider: 'codex', name: 'Synthetic research account' },
  { id: 'capacity-fixture-b', provider: 'codex', name: 'Synthetic batch account' },
  { id: 'connection-fixture-custom', provider: 'openai-compatible-redesign-fixture', name: 'Synthetic custom upstream with neutral provider identity' },
  { id: 'connection-fixture-reauth', provider: 'claude', name: 'Synthetic expired credential account' },
  { id: 'connection-fixture-claude-research', provider: 'claude', name: 'Synthetic research writing team' },
  { id: 'connection-fixture-gemini-primary', provider: 'gemini', name: 'Synthetic multimodal primary' },
  { id: 'connection-fixture-gemini-batch', provider: 'gemini', name: 'Synthetic multimodal batch' },
  { id: 'connection-fixture-deepseek-primary', provider: 'deepseek', name: 'Synthetic reasoning primary' },
  { id: 'connection-fixture-deepseek-secondary', provider: 'deepseek', name: 'Synthetic reasoning secondary' },
  { id: 'connection-fixture-openai-archive', provider: 'openai', name: 'Synthetic archive workload' },
]);
// Presence in this catalog is a seed contract, not a browser acceptance claim.
export const SCENARIOS = Object.freeze({
  empty: { persistence: true, accounts: 0, states: ['new installation', 'empty histories', 'setup'], missing: ['completed identity-provider sign-in'] },
  single: { persistence: true, accounts: 1, states: ['one credentialless account', 'long account name', 'unknown quota'], missing: ['real provider validation'] },
  populated: { persistence: true, accounts: 4, states: ['repeated providers', 'constrained quota', 'unknown quota', 'stale quota', 'passed reset without replenishment', 'ordinary request', 'failed attempt and pinned retry', 'optimization applied and skipped', 'positive and negative stage deltas', 'known and unknown pricing', 'separate cache and shaping savings', 'unknown historical savings split', 'negative modeled savings', 'partial attribution', 'notification rule history'], missing: ['custom provider and broken logo', 'exhausted quota', 'concurrent in-flight attempts', 'optimization failure', 'zero-usage ledger exclusion', 'streaming interruption', 'reauthentication', 'version conflict', 'partial bulk outcome', 'interrupted activation', 'expired evidence'] },
  operator: { persistence: false, accounts: 5, source: '../operator-fixture.mjs', states: ['browser presentation mock', 'dense context history'], missing: ['persistence proof'] },
  'edge-cases': { persistence: true, accounts: 6, states: ['all populated states', 'custom provider with neutral identity', 'exhausted quota', 'credential-expired state without credentials', 'synthetic concurrent process counters', 'terminal shaping telemetry failure', 'aborted request history', 'zero-usage counterfactual exclusion', 'expired session pin and preview', 'free and bound proxy pools for partial deletion'], missing: ['real provider dispatch', 'completed reauthentication', 'actual concurrent admission', 'browser fault scenario acceptance'] },
  representative: { persistence: true, accounts: 12, states: ['all edge-cases states', 'six provider identities with repeated accounts', 'eight locally enabled credentialless accounts', 'fresh/stale/unknown synthetic quota observations', '48 additional exact request/context/usage/cost histories'], missing: ['usable provider credentials', 'verified provider health or entitlement', 'actual provider traffic'] },
});
export const BROWSER_FAULTS = Object.freeze({ 'broken-logo': { persistence: false, target: '/providers/openai.png', effect: '404 local asset exercises initials fallback' }, 'version-conflict': { persistence: false, target: '/api/admin/configuration/drafts/*', effect: 'One explicit local PATCH is refused with a revision conflict' }, 'interrupted-activation': { persistence: false, target: '/api/admin/configuration/drafts/*/activate', effect: 'Explicit local activation may persist; its response is deliberately lost' }, 'stream-interruption': { persistence: false, target: '/v1/chat/completions', effect: 'Synthetic text events followed by a reader error, with no gateway request' } });
export const MUTATIONS = Object.freeze(['investigations', 'configuration drafts and scoped activation', 'synthetic account policy and drain', 'access profiles and local keys', 'model policy', 'notification rules', 'local compatibility', 'shaping controls/plans/runtime settings', 'pricing overrides', 'synthetic budget reconciliation', 'declarative custom adapter', 'partial proxy-pool deletion']);
