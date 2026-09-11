import { QUOTA_AUTOPING_CONFIG } from '@/shared/constants/config';
import { windowHorizonMs } from '@/shared/utils/quotaRanking.js';

// ONE PRESENTATION PER DURATION. A window of a given length reads and sorts the
// same way whatever its provider calls it, so Kimi's "Ratelimit" and Claude's
// "session (5h)" — both exactly 18000000ms — can no longer disagree about
// either. They used to, because every provider carried its own hand-written
// [label, order] pair and the pairs drifted: the same 5h window sat at order 0
// on kimi and order 1 on claude.
//
// `order` is the INDEX here rather than a written-down number, so the sort
// position cannot fall out of step with the label. Ascending by period, which
// is also what accountBoardModel's "a depleted longer window hides its shorter
// ones" rule reads.
const PERIOD_PRESENTATION = [
  [3_600_000, 'Hourly', '1h'],
  [18_000_000, 'Session', '5h'],
  [86_400_000, 'Daily', '24h'],
  [604_800_000, 'Weekly', '7d'],
  [2_592_000_000, 'Monthly', '30d'],
];

// A window whose period is neither declared nor parseable keeps its own name and
// sorts after everything identifiable. Nothing here guesses a duration.
const UNKNOWN_ORDER = PERIOD_PRESENTATION.length;

// Which keys a provider reports as WHOLE-ACCOUNT windows. Membership only: the
// name and the order come from the period below, so this table cannot be the
// place two providers disagree about how a 5h window reads. Codex is absent
// because its keys are structured (`spark_weekly`, `session_primary`) and are
// matched by pattern instead.
const generalWindows = {
  claude: ['session (5h)', 'weekly (7d)'],
  ollama: ['Session (5h)', 'Weekly (7d)'],
  'opencode-go': ['Rolling (5h)', 'Weekly', 'Monthly'],
  kimi: ['Ratelimit', 'Weekly'],
};

const isGeneral = (provider, key) =>
  Object.hasOwn(generalWindows, provider) && generalWindows[provider].includes(key);

/**
 * The period of one window in ms, or null when it cannot be sourced.
 *
 * The DECLARED period wins (QUOTA_AUTOPING_CONFIG.windowPeriodsMs, which is
 * where a provider that names a window something unparseable — "Ratelimit" —
 * already states what it is), then a duration parseable out of the name by the
 * same parser the ranker uses. Both are existing sources of truth, so no second
 * lookup table is introduced here to drift against them.
 */
function periodMs(provider, key) {
  const declared = QUOTA_AUTOPING_CONFIG.providers?.[provider]?.windowPeriodsMs;
  const value = Number(declared && Object.hasOwn(declared, key) ? declared[key] : NaN);
  if (Number.isFinite(value) && value > 0) return value;
  // windowHorizonMs returns 1ms for a name it cannot read. That is a sentinel,
  // not a period, and anything under a minute is that sentinel.
  const parsed = windowHorizonMs(key);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : null;
}

/** Label and order for a window, or null when its period cannot be sourced. */
function present(provider, key, position = null) {
  const ms = periodMs(provider, key);
  const order = PERIOD_PRESENTATION.findIndex(([period]) => period === ms);
  if (order < 0) return null;
  const [, name, duration] = PERIOD_PRESENTATION[order];
  return { label: `${name} (${position ? `${duration}, ${position}` : duration})`, order };
}

const unchanged = (key) => ({
  id: `scope:${key}`,
  productLabel: key,
  label: key,
  order: UNKNOWN_ORDER,
});
const general = ({ label, order }) => ({ id: 'general', productLabel: 'General', label, order });

function describeWindow(provider, key) {
  if (provider === 'codex') {
    const match =
      /^(?:(spark|review)_)?(hourly|session|daily|weekly|monthly)(?:_(primary|secondary))?$/.exec(
        key
      );
    if (match) {
      const [, product, period, position] = match;
      const shown = present(provider, period, position);
      return {
        id: product || 'general',
        productLabel:
          product === 'spark' ? 'Codex Spark' : product === 'review' ? 'Code review' : 'General',
        label: shown ? shown.label : key,
        order: shown ? shown.order : UNKNOWN_ORDER,
      };
    }
  }
  // Anthropic reports the per-model branches of one weekly plan beside the
  // plan-wide window. They are sub-quotas and keep their own product.
  if (provider === 'claude') {
    const match = /^weekly (.+) \(7d\)$/.exec(key);
    if (match)
      return {
        id: `model:${match[1]}`,
        productLabel: match[1],
        ...present(provider, key.slice(7)),
      };
  }
  // Minimax meters per model and every key is "<model> (<duration>)", so the
  // pattern IS the classifier here. A duration it does not support is left
  // alone rather than falling through to the general resolver below.
  if (provider === 'minimax' || provider === 'minimax-cn') {
    const match = /^(.+) \((5h|7d)\)$/.exec(key);
    return match
      ? { id: `model:${match[1]}`, productLabel: match[1], ...present(provider, key) }
      : unchanged(key);
  }
  if (isGeneral(provider, key)) {
    const shown = present(provider, key);
    if (shown) return general(shown);
  }
  // GLM names a session window with no duration anywhere: not in its payload,
  // not in config, not in the name. It stays a bare "Session" rather than being
  // assigned a length nothing in the tree can source.
  if (provider === 'glm' || provider === 'glm-cn') {
    const match = /^session(?: \(([2-9]|[1-9]\d+)\))?$/.exec(key);
    if (match) return general({ label: match[1] ? `Session (${match[1]})` : 'Session', order: 1 });
  }
  return unchanged(key);
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const productOrder = (id) => (id === 'general' ? 0 : id === 'spark' ? 1 : id === 'review' ? 2 : 3);

export function groupQuotaProducts(provider, windows) {
  const groups = new Map();
  const described = windows.map((window) => ({ window, ...describeWindow(provider, window.key) }));
  described.sort(
    (a, b) =>
      productOrder(a.id) - productOrder(b.id) ||
      compareText(a.id, b.id) ||
      a.order - b.order ||
      compareText(a.window.key, b.window.key)
  );
  for (const { window, id, productLabel, label, order } of described) {
    if (!groups.has(id)) groups.set(id, { id, label: productLabel, windows: [] });
    groups.get(id).windows.push({ ...window, label, order });
  }
  return [...groups.values()];
}
