import { describe, expect, it } from 'vitest';
import { groupQuotaProducts } from '@/app/dashboard/quotaProductGroups.js';

// The reported defect: a Kimi account meters a 5h window and a 7d window that
// mean exactly what Claude's do (config.js declares Ratelimit as 18000000ms and
// Weekly as 604800000ms), yet the dashboard named them differently AND sorted
// them differently — kimi's 5h window carried order 0 while claude's carried 1.
const reading = (key) => ({
  key,
  remaining: 50,
  unlimited: false,
  resetAt: null,
  observedAt: null,
  threshold: 0,
});

const shown = (provider, key) => {
  const window = groupQuotaProducts(provider, [reading(key)])
    .flatMap((group) => group.windows)
    .find((item) => item.key === key);
  return [window.label, window.order];
};

const FIVE_HOUR = [
  ['claude', 'session (5h)'],
  ['codex', 'session'],
  ['kimi', 'Ratelimit'],
  ['ollama', 'Session (5h)'],
  ['opencode-go', 'Rolling (5h)'],
];

const SEVEN_DAY = [
  ['claude', 'weekly (7d)'],
  ['codex', 'weekly'],
  ['kimi', 'Weekly'],
  ['ollama', 'Weekly (7d)'],
  ['opencode-go', 'Weekly'],
];

describe('quota window presentation parity across providers', () => {
  it('gives every 5h window the same label and the same order', () => {
    for (const [provider, key] of FIVE_HOUR) {
      expect(shown(provider, key), `${provider} ${key}`).toEqual(['Session (5h)', 1]);
    }
  });

  it('gives every 7d window the same label and the same order', () => {
    for (const [provider, key] of SEVEN_DAY) {
      expect(shown(provider, key), `${provider} ${key}`).toEqual(['Weekly (7d)', 3]);
    }
  });

  it('sorts the 5h window before the 7d one for every provider', () => {
    for (const [index, [provider, fiveHour]] of FIVE_HOUR.entries()) {
      const sevenDay = SEVEN_DAY[index][1];
      const labels = groupQuotaProducts(provider, [reading(sevenDay), reading(fiveHour)]).flatMap(
        (group) => group.windows.map((window) => window.label)
      );
      expect(labels, provider).toEqual(['Session (5h)', 'Weekly (7d)']);
    }
  });

  it('keeps provider product grouping intact while the windows read alike', () => {
    const codex = groupQuotaProducts(
      'codex',
      ['session', 'weekly', 'spark_session', 'review_weekly'].map(reading)
    );
    expect(
      codex.map((group) => [group.label, group.windows.map((window) => window.label)])
    ).toEqual([
      ['General', ['Session (5h)', 'Weekly (7d)']],
      ['Codex Spark', ['Session (5h)']],
      ['Code review', ['Weekly (7d)']],
    ]);
    const claude = groupQuotaProducts(
      'claude',
      ['session (5h)', 'weekly (7d)', 'weekly opus (7d)'].map(reading)
    );
    expect(
      claude.map((group) => [group.label, group.windows.map((window) => window.label)])
    ).toEqual([
      ['General', ['Session (5h)', 'Weekly (7d)']],
      ['opus', ['Weekly (7d)']],
    ]);
  });

  it('never invents a duration it cannot source', () => {
    // GLM declares no period and its name carries none, so it stays bare.
    expect(shown('glm', 'session')).toEqual(['Session', 1]);
    // An unrecognised provider is not assumed to mean what codex means by the
    // same word, so the key is presented exactly as received.
    expect(shown('future-provider', 'session')).toEqual(['session', 5]);
    expect(shown('codex', 'spark_pool')).toEqual(['spark_pool', 5]);
  });
});
