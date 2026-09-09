import { createConfigurationRepository } from './configVersionsRepo.js';
import {
  DOMAIN_SCOPE,
  DOMAIN_COVERAGE,
  readConfigurationDomains,
  assertConfigurationDomains,
  validateConfigurationDomains,
  writeConfigurationDomains,
  configurationDomainReferences,
} from '../../configuration/configurationDomains.js';

async function refresh(before, after) {
  const { invalidateDisabledModelsCache } = await import('./disabledModelsRepo.js');
  invalidateDisabledModelsCache();
  const { notifyQuotaPolicyChange } = await import('./connectionsRepo.js');
  let failed = false;
  for (const [id, account] of Object.entries(after.accounts)) {
    if (
      before.accounts[id]?.isActive !== account.isActive &&
      (await notifyQuotaPolicyChange(id)) === false
    )
      failed = true;
  }
  if (failed) throw new Error('quota_refresh_failed');
}

export const configurationDomains = createConfigurationRepository({
  scope: DOMAIN_SCOPE,
  coverage: DOMAIN_COVERAGE,
  read: readConfigurationDomains,
  assert: assertConfigurationDomains,
  validateDocument: validateConfigurationDomains,
  write: writeConfigurationDomains,
  refresh,
  references: configurationDomainReferences,
  requireDraftBase: true,
});
