import { expect, it } from 'vitest';
import { privateEnvironment } from '../../scripts/qa/verify-standalone.mjs';

it('marks built artifact fixtures as test traffic independently of production Node mode and inherited overrides', () => {
  const env = privateEnvironment('/tmp/tokenproxy-origin-fixture', { TOKENPROXY_TELEMETRY_ORIGIN: 'production' });
  expect(env.NODE_ENV).toBe('production');
  expect(env.TOKENPROXY_TELEMETRY_ORIGIN).toBe('test');
  expect(env.DATA_DIR).toBe('/tmp/tokenproxy-origin-fixture/data');
});
