// The card word an operator reads must be one of the four categories the board
// offers as filters. A previous build shipped four category chips beside a
// seven-word vocabulary on the rows ("Low quota", "Out of quota",
// "Needs sign-in", "Quota pause", "Draining", "Attention", "Ready"), and the
// rendered harness stayed green throughout because it asserted the chips and
// never the row word. This file asserts the property directly, over every state
// that reaches the board, so a fifth word cannot return unnoticed.
import { describe, expect, it } from 'vitest';
import { CATEGORIES, accountStateWord } from '@/app/dashboard/accountBoardModel';

const LABELS = new Set(CATEGORIES.map((item) => item.label));
const NOW = Date.parse('2026-09-12T12:00:00Z');
const minutes = (count) => new Date(NOW + count * 60_000).toISOString();
const account = (fields = {}, windows = null) => ({
  id: 'fixture', provider: 'openai', isActive: true, status: 'qualified', hasCredential: true,
  ...(windows === null ? {} : { lastQuotaSnapshot: { fetchedAt: minutes(-2), windows } }),
  ...fields,
});

// One row per state the board can reach, named by the word it used to show.
const ROWS = [
  ['healthy', account()],
  ['low window', account({}, [{ key: 'weekly', remainingPercentage: 8, resetAt: minutes(3000) }])],
  ['depleted window', account({}, [{ key: 'weekly', remainingPercentage: 0, resetAt: minutes(600) }])],
  ['operator hold', account({ isActive: false, status: 'unqualified' })],
  ['draining', account({ isDraining: true })],
  ['cooldown', account({ status: 'cooldown' })],
  ['degraded', account({ status: 'degraded' })],
  ['quota pause', account({ quotaPauseThresholds: { weekly: 80 } })],
  ['missing credential', account({ hasCredential: false })],
  ['401 disabled', account({ isActive: false, errorCode: 401, lastError: 'x-api-key header is required' })],
  ['403 disabled', account({ isActive: false, errorCode: 403, lastError: 'forbidden' })],
  ['never checked', account({ status: 'unqualified' }, [])],
];

describe('the card word is always one of the four categories', () => {
  for (const [name, row] of ROWS) {
    it(`${name} reads as a category, not a private word`, () => {
      expect(LABELS).toContain(accountStateWord(row, NOW));
    });
  }

  it('offers exactly the four the user asked for', () => {
    expect([...LABELS].sort()).toEqual(['Active', 'Cooldown', 'Paused', 'Unknown']);
  });
});
