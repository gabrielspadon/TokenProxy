import { expect, it } from 'vitest';
import { keyBudgetMeasurements, keyBudgetState } from '../../src/app/dashboard/keys/budget.js';

const fixture = () => ({ isActive: true, maxCostUsd: 10, usage: { costUsd: 1 },
  budget: { durableStorage: true, policy: 'reserve-remaining',
    recorded: { costUsd: 3, unknownCostRows: 0 },
    outstanding: { costUsd: 7, unknownCostBounds: 0 } } });

it('uses the lifetime ledger and includes held allowance when explaining a capped key', () => {
  const key = fixture();
  expect(keyBudgetState(key).state).toBe('held');
  const row = keyBudgetMeasurements(key).find(row => row.used === 'costUsd');
  expect(row).toMatchObject({ recorded: 3, held: 7, ceiling: 10, unknownRecorded: 0, unknownHeld: 0, source: 'Lifetime application ledger' });
});

it('keeps an absent projection and absent historic coverage unknown', () => {
  const key = { isActive: true, maxCostUsd: 10, usage: { costUsd: 0 } };
  expect(keyBudgetState(key).state).toBe('unknown');
  const row = keyBudgetMeasurements(key).find(row => row.used === 'costUsd');
  expect(row).toMatchObject({ recorded: 0, held: null, unknownRecorded: null, unknownHeld: null, source: 'Retained usage history' });
});

it('does not convert missing monetary or token values to zero', () => {
  for (const value of [undefined, null, '0', NaN, Infinity, -1]) {
    const key = { usage: { promptTokens: value, completionTokens: value, costUsd: value } };
    expect(keyBudgetMeasurements(key).every(row => row.recorded === null)).toBe(true);
  }
});

it('labels unknown outstanding bounds independently of a small recorded balance', () => {
  const key = fixture(); key.budget.outstanding = { costUsd: 0, unknownCostBounds: 1 };
  expect(keyBudgetState(key).label).toBe('Unresolved exposure');
});

it('explains strict incomplete records and unsupported durable storage', () => {
  const key = fixture(); key.budget.outstanding.costUsd = 0;
  key.budget.policy = 'strict'; key.budget.recorded.unknownCostRows = 2;
  expect(keyBudgetState(key).label).toBe('Incomplete usage evidence');
  key.budget.durableStorage = false;
  expect(keyBudgetState(key).label).toBe('Durable storage required');
});

it('prioritizes disabled or expired keys and does not promise future admission', () => {
  const key = fixture(); key.isActive = false;
  expect(keyBudgetState(key).state).toBe('off');
  key.isActive = true; key.isExpired = true;
  expect(keyBudgetState(key).state).toBe('expired');
  expect(keyBudgetState({ isActive: true }).label).toBe('Enabled');
});

it('recognizes a literal zero ceiling as exhausted', () => {
  const key = fixture(); key.maxCostUsd = 0; key.budget.recorded.costUsd = 0;
  expect(keyBudgetState(key).state).toBe('over');
});
