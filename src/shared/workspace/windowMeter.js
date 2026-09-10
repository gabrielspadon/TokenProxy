// A context window drawn as a status meter. The bar length compares against the
// widest window on the board; the colour is the band the number itself falls in,
// because a share of the widest would paint a perfectly usable 200k model red
// next to a 2M one.
export const BANDS = { good: 200000, warn: 32000 };

const known = (value) => Number.isFinite(value) && value > 0;

export function windowMeter(effective, widest) {
  if (!known(effective)) return { level: null, remaining: null, unknown: true };
  const share = known(widest) ? Math.max(2, Math.round((effective / widest) * 100)) : 100;
  return {
    level: effective >= BANDS.good ? 'good' : effective >= BANDS.warn ? 'warn' : 'low',
    remaining: share,
    unknown: false,
  };
}

export const widestOf = (values) =>
  values.reduce((widest, value) => (known(value) && value > widest ? value : widest), 0);
