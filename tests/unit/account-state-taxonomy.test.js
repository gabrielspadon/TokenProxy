// The word the board puts on an account that is switched off.
//
// One word, "Paused", used to cover three unrelated facts, and two of them were
// never an operator decision. Measured on the live instance on 2026-09-11, all
// four accounts rendering as "Paused" were 401s: one openrouter row with
// `[401]: User not found.` and three credential-less legacy rows with
// `[401]: x-api-key header is required`. None carried a quotaPauseThresholds
// value, so getPausedWindow returned null for every one of them and the quota
// auto-pause had not fired. The mechanism was innocent; the label was wrong.
//
// Each case below cites the field that decides it:
//   - hasCredential            src/lib/providerNormalization.js, derived there
//                              from holdsCredential so the token stays server-side
//   - testStatus / errorCode   src/sse/services/auth.js:1086 and :1117, the two
//                              paths that switch an account off automatically
//   - the crossed window       src/shared/utils/quotaPause.js, getPausedWindow
//   - isActive alone           the ONLY input that may still say "Paused"
import { describe, expect, it } from 'vitest';
import {
  accountControlState,
  accountFailure,
} from '@/app/dashboard/accountControlPanelModel';
import {
  accountBucket,
  accountSection,
  accountStateReason,
  accountStateWord,
} from '@/app/dashboard/accountBoardModel';
import { holdsCredential } from '@/shared/utils/accountCredential.js';
import { redactConnectionSecrets } from '@/lib/providerNormalization';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const minutes = (value) => new Date(NOW + value * 60000).toISOString();

// A healthy, serving account. Every case is this minus exactly one thing.
const account = (overrides = {}) => ({
  id: 'a',
  connectionId: 'a',
  provider: 'codex',
  authType: 'oauth',
  displayName: 'Account A',
  isActive: true,
  hasCredential: true,
  status: 'healthy',
  quotaPauseThresholds: {},
  lastQuotaSnapshot: {
    fetchedAt: minutes(-2),
    windows: [{ key: 'weekly', remainingPercentage: 60, resetAt: minutes(3000) }],
  },
  ...overrides,
});

// The state, the section and the chip word, read together. Each is a separate
// surface an operator scans, and the defect was that all three agreed on the
// wrong answer, so pinning one of them would not have caught it.
const reads = (row) => ({
  state: accountControlState(row, NOW),
  section: accountSection(row, NOW),
  bucket: accountBucket(row, NOW),
  word: accountStateWord(row, NOW),
});

describe('one word per state, and only one of them is "Paused"', () => {
  it('an operator hold is the only state that says Paused, and it says nothing failed', () => {
    const row = account({ isActive: false, status: 'unqualified' });
    expect(accountFailure(row)).toBeNull();
    expect(reads(row)).toEqual({
      state: 'Paused',
      section: 'held',
      bucket: 'paused',
      word: 'Paused',
    });
    expect(accountStateReason(row, NOW)).toMatch(/Nothing has failed/);
  });

  it('a crossed threshold is a quota pause, named with its window and its line', () => {
    const row = account({
      quotaPauseThresholds: { weekly: 10 },
      lastQuotaSnapshot: {
        fetchedAt: minutes(-2),
        windows: [{ key: 'weekly', remainingPercentage: 4, resetAt: minutes(600) }],
      },
    });
    expect(reads(row)).toEqual({
      state: 'Quota pause',
      section: 'resting',
      bucket: 'quotaHold',
      word: 'Quota pause',
    });
    // The operator configured this one, so the card names both numbers.
    expect(accountStateReason(row, NOW)).toBe(
      'weekly is at 4% left, under your 10% pause line'
    );
  });

  it('a 401 that disabled the account asks for a sign-in and never reads as Paused', () => {
    // The live openrouter row, field for field.
    const row = account({
      provider: 'openrouter',
      isActive: false,
      status: 'unqualified',
      testStatus: 'unavailable',
      errorCode: 401,
      lastError: '[401]: User not found.',
    });
    expect(accountFailure(row)).toBe('auth');
    expect(reads(row)).toEqual({
      state: 'Needs sign-in',
      section: 'action',
      bucket: 'attention',
      word: 'Needs sign-in',
    });
    expect(accountControlState(row, NOW)).not.toBe('Paused');
    // "Cooling down" promises a return nobody is coming back from.
    expect(accountSection(row, NOW)).not.toBe('resting');
    expect(accountStateReason(row, NOW)).toBe('[401]: User not found.');
  });

  it('the codex reauth path is the same state, read from testStatus alone', () => {
    // src/sse/services/auth.js:1086 writes testStatus reauth_required with the
    // 401; the state must not depend on both fields surviving.
    const row = account({ isActive: false, testStatus: 'reauth_required' });
    expect(accountControlState(row, NOW)).toBe('Needs sign-in');
  });

  it('a 403 that disabled the account is an error, not a sign-in and not a pause', () => {
    // src/sse/services/auth.js:1117, Qoder quota exhaustion. Calling it "Needs
    // sign-in" would be the same class of lie one layer down.
    const row = account({
      provider: 'qoder',
      isActive: false,
      status: 'unqualified',
      testStatus: 'unavailable',
      errorCode: 403,
      lastError: 'Qoder quota exhausted (code 112)',
    });
    expect(accountFailure(row)).toBe('error');
    expect(reads(row)).toEqual({
      state: 'Disabled by error',
      section: 'action',
      bucket: 'attention',
      word: 'Disabled by error',
    });
    expect(accountStateReason(row, NOW)).toBe('Qoder quota exhausted (code 112)');
  });

  it('a row holding no credential says so, active or not', () => {
    const off = account({ hasCredential: false, isActive: false });
    expect(reads(off)).toEqual({
      state: 'No credential',
      section: 'action',
      bucket: 'attention',
      word: 'No credential',
    });
    expect(accountControlState(off, NOW)).not.toBe('Paused');
    // Still true of a row nobody switched off: it cannot answer either way.
    expect(accountControlState(account({ hasCredential: false }), NOW)).toBe('No credential');
    expect(accountStateReason(off, NOW)).toMatch(/No credential stored/);
  });

  it('leaves a serving account exactly where it was', () => {
    expect(reads(account())).toEqual({
      state: 'Enabled',
      section: 'serving',
      bucket: 'ready',
      word: 'Ready',
    });
    expect(accountStateReason(account(), NOW)).toBeNull();
  });
});

describe('the four accounts that were all reading "Paused" on 2026-09-11', () => {
  // Three credential-less legacy rows and one openrouter 401. No thresholds on
  // any of them, so the quota auto-pause provably did not fire.
  const live = [
    account({
      id: '01d2af87',
      provider: 'openrouter',
      authType: 'apikey',
      hasCredential: true,
      isActive: false,
      testStatus: 'unavailable',
      errorCode: 401,
      lastError: '[401]: User not found.',
      lastQuotaSnapshot: null,
    }),
    ...[1, 2, 3].map((n) =>
      account({
        id: `legacy-account-${n}`,
        provider: 'claude',
        hasCredential: false,
        isActive: false,
        testStatus: 'unavailable',
        errorCode: 401,
        lastError: '[401]: x-api-key header is required',
        lastQuotaSnapshot: null,
      })
    ),
  ];

  it('reads none of them as Paused and files none of them under Cooling down', () => {
    expect(live.map((row) => accountControlState(row, NOW))).toEqual([
      'Needs sign-in',
      'No credential',
      'No credential',
      'No credential',
    ]);
    expect(new Set(live.map((row) => accountSection(row, NOW)))).toEqual(new Set(['action']));
  });

  it('gives each card a reason drawn from what actually switched it off', () => {
    expect(live.map((row) => accountStateReason(row, NOW))).toEqual([
      '[401]: User not found.',
      'No credential stored, so this account cannot answer',
      'No credential stored, so this account cannot answer',
      'No credential stored, so this account cannot answer',
    ]);
  });
});

describe('hasCredential reaches the board without the credential doing so', () => {
  // The dashboard cannot run holdsCredential itself: /api/providers strips every
  // token first, so a client-side rule would report every OAuth account as
  // credential-less. The boolean is derived at the redaction point instead.
  it('derives the flag from the raw row and still removes the token', () => {
    const loaded = redactConnectionSecrets({
      id: 'one',
      authType: 'oauth',
      refreshToken: 'rt-secret',
    });
    expect(loaded.hasCredential).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain('rt-secret');

    expect(redactConnectionSecrets({ id: 'two', authType: 'oauth' }).hasCredential).toBe(false);
    expect(redactConnectionSecrets({ id: 'three', authType: 'cookie' }).hasCredential).toBe(true);
  });

  it('is the gateway own predicate, not a second rule', () => {
    const row = { authType: 'oauth', accessToken: 'at' };
    expect(redactConnectionSecrets(row).hasCredential).toBe(holdsCredential(row));
  });
});
