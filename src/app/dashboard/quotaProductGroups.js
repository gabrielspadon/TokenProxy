const general = (label, order) => ({ id: 'general', productLabel: 'General', label, order });

// Explicit presentation names for received keys; no period implies a reset duration.
const codexPeriods = { hourly: ['Hourly', 0], session: ['Session', 1], daily: ['Daily', 2], weekly: ['Weekly', 3], monthly: ['Monthly', 4] };

// These names belong to the usage adapters, not to a generic period parser.
const providerWindows = {
  claude: { 'session (5h)': ['Session (5h)', 1], 'weekly (7d)': ['Weekly (7d)', 3] },
  ollama: { 'Session (5h)': ['Session (5h)', 1], 'Weekly (7d)': ['Weekly (7d)', 3] },
  'opencode-go': { 'Rolling (5h)': ['Rolling (5h)', 1], Weekly: ['Weekly', 3], Monthly: ['Monthly', 4] },
  kimi: { Weekly: ['Weekly', 3], Ratelimit: ['Rate limit', 5] },
};

function describeWindow(provider, key) {
  if (provider === 'codex') {
    const match = /^(?:(spark|review)_)?(hourly|session|daily|weekly|monthly)(?:_(primary|secondary))?$/.exec(key);
    if (match) {
      const [, product, period, position] = match;
      return {
        id: product || 'general',
        productLabel: product === 'spark' ? 'Codex Spark' : product === 'review' ? 'Code review' : 'General',
        label: `${codexPeriods[period][0]}${position ? ` (${position})` : ''}`,
        order: codexPeriods[period][1],
      };
    }
  }
  const known = Object.hasOwn(providerWindows, provider) && Object.hasOwn(providerWindows[provider], key)
    ? providerWindows[provider][key] : null;
  if (known) return general(...known);
  if (provider === 'claude') {
    const match = /^weekly (.+) \(7d\)$/.exec(key);
    if (match) return { id: `model:${match[1]}`, productLabel: match[1], label: 'Weekly (7d)', order: 3 };
  }
  if (provider === 'minimax' || provider === 'minimax-cn') {
    const match = /^(.+) \((5h|7d)\)$/.exec(key);
    if (match) return { id: `model:${match[1]}`, productLabel: match[1], label: match[2] === '5h' ? 'Session (5h)' : 'Weekly (7d)', order: match[2] === '5h' ? 1 : 3 };
  }
  if (provider === 'glm' || provider === 'glm-cn') {
    const match = /^session(?: \(([2-9]|[1-9]\d+)\))?$/.exec(key);
    if (match) return general(match[1] ? `Session (${match[1]})` : 'Session', 1);
  }
  return { id: `scope:${key}`, productLabel: key, label: key, order: 5 };
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const productOrder = id => id === 'general' ? 0 : id === 'spark' ? 1 : id === 'review' ? 2 : 3;

export function groupQuotaProducts(provider, windows) {
  const groups = new Map();
  const described = windows.map(window => ({ window, ...describeWindow(provider, window.key) }));
  described.sort((a, b) => productOrder(a.id) - productOrder(b.id) || compareText(a.id, b.id)
    || a.order - b.order || compareText(a.window.key, b.window.key));
  for (const { window, id, productLabel, label } of described) {
    if (!groups.has(id)) groups.set(id, { id, label: productLabel, windows: [] });
    groups.get(id).windows.push({ ...window, label });
  }
  return [...groups.values()];
}
