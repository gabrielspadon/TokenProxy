import { describe, expect, it } from 'vitest';
import { selectAndReserve } from '../../../src/sse/services/accountScheduler.js';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const HOUR = 3_600_000;
const window = (scope, hours, remaining = 80) => ({ scope, resetAt: new Date(NOW + hours * HOUR).toISOString(), observedAt: new Date(NOW).toISOString(), remaining, limit: 100, confidence: 'fresh' });
const account = (id, monthly, weekly, session) => ({ id, priority: id === 'a' ? 0 : 100, windows: [window('monthly (30d)', monthly), window('weekly (7d)', weekly), window('session (5h)', session)] });

function substrate() {
  const pins = new Map();
  const receipts = [];
  const held = new Map();
  const caps = new Map();
  let transaction = false;
  const key = ({ sessionHash, model }) => `${sessionHash}\0${model}`;
  const check = () => { if (!transaction) throw new Error('State accessed outside selection transaction'); };
  const repos = {
    transaction(fn) { if (transaction) throw new Error('Nested transaction'); transaction = true; try { return fn(); } finally { transaction = false; } },
    getPin(args) { check(); return pins.get(key(args)) ?? null; },
    setPin(args) { check(); pins.set(key(args), { connectionId: args.connectionId, pinnedAt: args.at }); },
    touchPin() { check(); },
    countActivePins({ model }) { check(); const out = {}; for (const [k, pin] of pins) if (k.endsWith(`\0${model}`)) out[pin.connectionId] = (out[pin.connectionId] || 0) + 1; return out; },
    recordSwitch(receipt) { check(); receipts.push(receipt); return receipt; },
  };
  const registry = {
    inFlight(id) { return held.get(id) || 0; },
    reserve(id) { check(); if ((held.get(id) || 0) >= (caps.get(id) ?? 20)) return null; held.set(id, (held.get(id) || 0) + 1); return { id }; },
    release(lease) { held.set(lease.id, (held.get(lease.id) || 0) - 1); },
  };
  return { pins, receipts, held, caps, select(accounts, sessionHash = 'agent-one', model = 'claude-opus-4-8') { return selectAndReserve({ accounts, sessionHash, model, now: NOW, repos, registry }); }, release: registry.release };
}

describe('independent scheduler entitlement and cache boundary', () => {
  it('honors monthly then weekly then session reset lexicographically, ahead of idle load and configured priority', () => {
    const s = substrate();
    const accounts = [account('a', 100, 10, 0.1), account('b', 100, 5, 4)];
    s.held.set('b', 5);
    expect(s.select(accounts).connection.id).toBe('b');
    accounts[0].windows[0] = window('monthly (30d)', 50);
    expect(s.select(accounts, 'agent-two').connection.id).toBe('a');
  });

  it('holds a healthy agent pin through load changes and refuses its full capacity without spending a new cache', () => {
    const s = substrate();
    const accounts = [account('a', 50, 5, 1), account('b', 100, 10, 2)];
    const first = s.select(accounts);
    expect(first.connection.id).toBe('a');
    s.release(first.lease);
    accounts[1].windows[0] = window('monthly (30d)', 1);
    s.held.set('a', 10);
    expect(s.select(accounts).connection.id).toBe('a');
    s.caps.set('a', 11);
    const wait = s.select(accounts);
    expect(wait).toMatchObject({ unavailable: true, reason: 'at-capacity' });
    expect(wait.retryAfter).toBeGreaterThan(0);
    expect(s.receipts).toHaveLength(1);
    expect([...s.pins.values()].map((pin) => pin.connectionId)).toEqual(['a']);
  });

  it('spreads distinct agents only after equal entitlement deadlines, then retains both pins', () => {
    const s = substrate();
    const accounts = [account('a', 50, 5, 1), account('b', 50, 5, 1)];
    const a = s.select(accounts, 'agent-one');
    const b = s.select(accounts, 'agent-two');
    expect([a.connection.id, b.connection.id]).toEqual(['a', 'b']);
    s.release(a.lease); s.release(b.lease);
    expect(s.select(accounts, 'agent-two').connection.id).toBe('b');
    expect(s.select(accounts, 'agent-one').connection.id).toBe('a');
    expect(s.receipts).toHaveLength(2);
  });

  it('isolates exhausted Opus entitlement from healthy Sonnet entitlement on the same account', () => {
    const s = substrate();
    const accounts = [account('a', 50, 5, 1), account('b', 100, 10, 2)];
    accounts[0].windows.push(window('weekly opus (7d)', 5, 0));
    expect(s.select(accounts, 'opus-agent', 'claude-opus-4-8').connection.id).toBe('b');
    expect(s.select(accounts, 'sonnet-agent', 'claude-sonnet-4-6').connection.id).toBe('a');
  });

  it('honors account enabledModels restrictions while retaining other account inventory', () => {
    const s = substrate();
    const accounts = [account('a', 50, 5, 1), account('b', 100, 10, 2)];
    accounts[0].providerSpecificData = { enabledModels: ['claude-sonnet-4-6'] };
    expect(s.select(accounts, 'opus-agent', 'claude-opus-4-8').connection.id).toBe('b');
    expect(s.select(accounts, 'sonnet-agent', 'claude-sonnet-4-6').connection.id).toBe('a');
  });

  it('excludes depleted general quota even when a different window is unreadable', () => {
    const s = substrate();
    const accounts = [account('a', 50, 5, 1), account('b', 100, 10, 2)];
    accounts[0].windows[1].remaining = 0;
    accounts[0].windows.push({ scope: 'unknown-feature', remaining: '?', resetAt: 'unknown' });
    expect(s.select(accounts).connection.id).toBe('b');
  });
});
