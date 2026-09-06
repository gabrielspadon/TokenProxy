// Locale-aware formatting through Intl only, so no unit word needs a literal.
function lang() {
  return typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
}

export function fmtNum(value, options) {
  return new Intl.NumberFormat(lang(), options).format(value);
}

export function fmtUsd(value) {
  return fmtNum(value, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 });
}

export function fmtPct(ratio) {
  return fmtNum(ratio, { style: "percent", maximumFractionDigits: 2 });
}

export function fmtUnit(value, unit, digits = 0) {
  // Intl supports a closed list of sanctioned units; "character" and friends
  // throw. Fall back to the bare number rather than crashing the page.
  try {
    return fmtNum(value, { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: digits });
  } catch {
    return fmtNum(value, { maximumFractionDigits: digits });
  }
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return fmtUnit(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return fmtUnit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return `${fmtUnit(h, "hour")} ${fmtUnit(m % 60, "minute")}`;
  const d = Math.floor(h / 24);
  return `${fmtUnit(d, "day")} ${fmtUnit(h % 24, "hour")}`;
}

export function fmtLatency(ms) {
  if (ms < 1000) return `${fmtNum(ms, { maximumFractionDigits: 1 })} ms`;
  return `${fmtNum(ms / 1000, { maximumFractionDigits: 2 })} s`;
}

export function fmtTime(iso) {
  return new Intl.DateTimeFormat(lang(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

export function fmtRelative(iso, now = Date.now()) {
  const diff = new Date(iso).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: "always", style: "short" });
  const abs = Math.abs(diff) / 1000;
  if (abs < 60) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60000), "minute");
  if (abs < 172800) return rtf.format(Math.round(diff / 3600000), "hour");
  return rtf.format(Math.round(diff / 86400000), "day");
}

// The admin projection writes the Unix epoch where it has no timestamp.
export function isEpoch(iso) {
  return !iso || new Date(iso).getTime() <= 0;
}
