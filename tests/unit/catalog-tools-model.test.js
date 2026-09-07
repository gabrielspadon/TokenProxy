import { describe, expect, it } from 'vitest';
import { bulkDeleteUrl, diagnosticRows, parseBulkImport, verifyCatalogAction } from '@/app/dashboard/models/catalogToolsModel';

describe('catalog batch contracts', () => {
  it('accepts both import envelopes without discarding advanced fields', () => {
    const models = [{ providerAlias: 'synthetic', id: 'm', type: 'embedding', max_input_tokens: 1234, vision: false }];
    expect(parseBulkImport(JSON.stringify(models))).toEqual(models);
    expect(parseBulkImport(JSON.stringify({ models }))).toEqual(models);
    for (const body of [[], new Array(1001).fill(models[0]), [null], ['model']]) expect(() => parseBulkImport(JSON.stringify(body))).toThrow();
  });
  it('encodes each exact deletion identity and repeats the id parameter', () => {
    const url = new URL(bulkDeleteUrl('a/b', 'embedding', ['org/one', 'two&three']), 'http://local');
    expect(url.searchParams.get('providerAlias')).toBe('a/b');
    expect(url.searchParams.getAll('id')).toEqual(['org/one', 'two&three']);
    expect(url.searchParams.get('type')).toBe('embedding');
  });
  it('verifies successful partial import entries and their persisted capability fields', () => {
    const model = { providerAlias: 'p', id: 'a', type: 'llm', maxInputTokens: 1234, vision: true };
    const action = { kind: 'import', models: [model, { providerAlias: 'p', id: 'b' }] };
    const response = { results: [{ id: 'a', success: true, added: true }, { id: 'b', success: false }] };
    expect(verifyCatalogAction(action, response, { models: [model] })).toBe(true);
    expect(verifyCatalogAction(action, response, { models: [{ ...model, maxInputTokens: 999 }] })).toBe(false);
    expect(verifyCatalogAction(action, response, { models: [] })).toBe(false);
  });
  it('does not treat an already-registered entry as a capability overwrite', () => {
    expect(verifyCatalogAction({ kind: 'import', models: [{ providerAlias: 'p', id: 'a', vision: true }] }, { results: [{ success: true, added: false }] }, { models: [{ providerAlias: 'p', id: 'a', vision: false }] })).toBe(true);
  });
  it('verifies deletion only within the requested provider and kind', () => {
    const action = { kind: 'delete', provider: 'p', type: 'llm', ids: ['a'] }, response = { results: [{ id: 'a', success: true }] };
    expect(verifyCatalogAction(action, response, { models: [{ providerAlias: 'p', id: 'a', type: 'embedding' }] })).toBe(true);
    expect(verifyCatalogAction(action, response, { models: [{ providerAlias: 'p', id: 'a', type: 'llm' }] })).toBe(false);
  });
  it('requires all matching account cooldowns to disappear without claiming failure repair', () => {
    const action = { kind: 'cooldown', provider: 'p', model: 'a' };
    expect(verifyCatalogAction(action, {}, { models: [{ provider: 'p', model: 'a', status: 'unavailable' }] })).toBe(true);
    expect(verifyCatalogAction(action, {}, { models: [{ provider: 'p', model: 'a', status: 'cooldown', connectionId: 'other' }] })).toBe(false);
  });
  it('checks sync status and exact saved plan order', () => {
    expect(verifyCatalogAction({ kind: 'sync' }, { result: { status: 'updated' } }, { lastSync: 100, lastResult: { status: 'updated' } })).toBe(true);
    expect(verifyCatalogAction({ kind: 'sync' }, { result: { status: 'updated' } }, { lastSync: 100, lastError: 'disk', lastResult: { status: 'updated' } })).toBe(false);
    expect(verifyCatalogAction({ kind: 'sync', previousSync: 100 }, { result: { status: 'updated' } }, { lastSync: 100, lastResult: { status: 'updated' } })).toBe(false);
    expect(verifyCatalogAction({ kind: 'plan', name: 'test', models: ['p/a', 'q/b'] }, {}, { combos: [{ name: 'test', models: ['q/b', 'p/a'] }] })).toBe(false);
  });
  it('keeps failed diagnostics and measured zero latency in both response shapes', () => {
    expect(diagnosticRows({ ok: false, latencyMs: 0, error: 'refused' }, ['p/a'])).toEqual([{ model: 'p/a', ok: false, latencyMs: 0, error: 'refused' }]);
    const results = [{ model: 'p/a', ok: true }, { model: 'q/b', ok: false }];
    expect(diagnosticRows({ results }, [])).toEqual(results);
  });
});
