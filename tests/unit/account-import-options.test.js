import { expect, it } from 'vitest';
import { accountOptionFields, buildAccountOptions } from '@/app/dashboard/connections/AccountOptions';
import { buildProviderImport, IMPORT_METHODS, providerImportReceipt } from '@/app/dashboard/connections/ProviderImports';

it('preserves omitted write-only options and maps provider options without leaking them into unrelated fields', () => {
  const values = { name: 'Fixture Azure', defaultModel: 'deployment-model', globalPriority: '', maxConcurrent: '2', azureEndpoint: 'https://fixture.invalid', deployment: 'fixture-deployment', customHeaders: '' };
  expect(buildAccountOptions(values, accountOptionFields('azure'))).toEqual({ name: values.name, defaultModel: values.defaultModel,
    globalPriority: null, maxConcurrent: 2, providerSpecificData: { azureEndpoint: values.azureEndpoint, deployment: values.deployment } });
  expect(() => buildAccountOptions({ ...values, customHeaders: '[]' }, accountOptionFields('azure'))).toThrow('object');
  expect(buildAccountOptions({ ...values, clearHeaders: true }, accountOptionFields('azure')).providerSpecificData.customHeaders).toEqual({});
});
it('preserves an import wrapper and reports partial results without including credentials', () => {
  const method = IMPORT_METHODS.find(item => item.id === 'mixed');
  const body = { provider: 'codex', accounts: [{ refresh_token: 'fixture-secret' }] };
  expect(buildProviderImport(method, { document: JSON.stringify(body) })).toEqual(body);
  expect(() => buildProviderImport(method, { document: 'broken fixture-secret' })).toThrow('Enter valid account JSON.');
  const receipt = providerImportReceipt({ results: [{ index: 0, ok: true, id: 'fixture-id' }, { index: 1, ok: false, error: 'fixture-secret' }] });
  expect(receipt).toEqual({ ids: ['fixture-id'], failed: [2] });
  expect(JSON.stringify(receipt)).not.toContain('fixture-secret');
});
