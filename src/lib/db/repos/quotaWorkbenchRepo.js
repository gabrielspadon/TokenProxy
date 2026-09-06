import { getAdapter } from '../driver.js';
import { DATA_FILE } from '../paths.js';
import { readContextAnalytics } from '../analytics/client.js';
import { parseQuotaWorkbenchQuery } from '../analytics/quotaWorkbenchQueries.mjs';

export async function getQuotaWorkbench(params, { signal, now } = {}) {
  const query = parseQuotaWorkbenchQuery(params, { now });
  const writer = await getAdapter();
  return readContextAnalytics(
    { operation: 'quota-workbench', ...query },
    { file: DATA_FILE, driver: writer.driver, signal }
  );
}
