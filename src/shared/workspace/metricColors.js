export const METRIC_COLORS = Object.freeze({ input: '#3B62B3', cacheRead: '#7454A4', cacheWrite: '#A4691F', output: '#58657A', failure: '#B23A43', selected: '#006F78' });

const FALLBACKS = { ink: '#17232D', slate: '#52606D', rule: '#D9E1E7', paper: '#F4F6F8', raised: '#FFFFFF', signalWash: '#E5F5F4' };

// Canvas cannot interpret custom properties. Resolve the active semantic palette.
export function chartThemeColors() {
  if (typeof document === 'undefined') return { ...FALLBACKS };
  const tokens = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(FALLBACKS).map(([name, fallback]) => [
    name, tokens.getPropertyValue(name === 'signalWash' ? '--signal-wash' : `--${name}`).trim() || fallback,
  ]));
}

export function chartMetricColors() {
  if (typeof document === 'undefined') return { ...METRIC_COLORS };
  const tokens = getComputedStyle(document.documentElement);
  const properties = { input: '--metric-input', cacheRead: '--metric-cache', cacheWrite: '--metric-write', output: '--metric-output', failure: '--refusal', selected: '--signal' };
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, tokens.getPropertyValue(property).trim() || METRIC_COLORS[name]]));
}

// Preserve callbacks, data identities and explicit provider colors; only metric colors change with appearance.
export function themeChartMetrics(value, palette) {
  const equivalents = new Map(Object.entries(METRIC_COLORS).map(([name, color]) => [color.toLowerCase(), palette[name]]));
  function visit(item, key) {
    if (typeof item === 'string' && /color$/i.test(key)) return equivalents.get(item.toLowerCase()) || item;
    if (Array.isArray(item)) return item.map(value => visit(value, key));
    if (item && Object.getPrototypeOf(item) === Object.prototype) return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, visit(value, name)]));
    return item;
  }
  return visit(value, '');
}
