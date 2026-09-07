// Seed through createProviderConnection in the disposable preview only. These
// rows intentionally have no API key, token, cookie, or refresh credential.
export const connectionsKeysFixture = {
  version: 'connections-keys-v1',
  capturedAt: '2026-09-07T12:00:00.000Z',
  source: 'synthetic-local-policy',
  connections: [
    { provider: 'openai', name: 'Synthetic fixture account Alpha with a deliberately long project label', authType: 'apikey', isActive: false, priority: 1 },
    { provider: 'openai', name: 'Synthetic fixture account Beta', authType: 'apikey', isActive: false, priority: 2 },
  ],
  outboundEffects: 'All outbound transports, provider validation, OAuth, inference and process control must remain blocked.',
};

export const connectionsKeysMutations = [
  ['POST', '/api/access-profiles'], ['PUT', '/api/access-profiles/:id'], ['DELETE', '/api/access-profiles/:id'],
  ['POST', '/api/keys'], ['PUT', '/api/keys/:id'], ['DELETE', '/api/keys/:id'],
  ['POST', '/api/keys/:id/reveal'], ['POST', '/api/keys/:id/rotate'],
  ['POST', '/api/keys/:id/profile'], ['DELETE', '/api/keys/:id/profile'],
  ['POST', '/api/keys/:id/connectivity'],
  ['PUT', '/api/providers/:syntheticId'],
  ['POST', '/api/proxy-pools'], ['PUT', '/api/proxy-pools/:syntheticId'], ['DELETE', '/api/proxy-pools/:syntheticId'],
  ['POST', '/api/provider-nodes'], ['PUT', '/api/provider-nodes/:syntheticId'], ['DELETE', '/api/provider-nodes/:syntheticId'],
  ['POST', '/api/models/disabled'], ['DELETE', '/api/models/disabled'],
];
