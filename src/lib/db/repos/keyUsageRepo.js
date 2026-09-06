import { getAdapter } from '../driver.js';
import { DATA_FILE } from '../paths.js';
import { readContextAnalytics } from '../analytics/client.js';

export async function getKeyUsageSnapshot({ signal } = {}) {
  const writer = await getAdapter();
  return readContextAnalytics({ operation: 'key-usage' }, { file: DATA_FILE, driver: writer.driver, signal });
}
