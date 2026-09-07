// Synthetic retained events for operator presentation checks. Never imported
// by application source or replayed against a provider.
export const shapingControlFixture = {
  version: 'shaping-controls-v1',
  capturedAt: '2026-09-07T12:00:00.000Z',
  sourceRevision: '3d7fe07c',
  population: 'Eight synthetic stage observations; no provider completions',
  invariants: [
    'Stage observations are not logical request counts.',
    'Signed byte changes include content growth.',
    'A measured zero and an absent byte measurement remain distinct.',
    'Historical execution does not establish the current configured state.',
    'No token or monetary saving is established by these events.',
  ],
  events: [
    { rid: '00000001', saver: 'rtk', applied: true, bytesSaved: -2048, charsBefore: 4096, charsAfter: 3072, charsSaved: 1024 },
    { rid: '00000002', saver: 'diet', applied: true, bytesSaved: -8192 },
    { rid: '00000003', saver: 'diet', applied: false, bytesSaved: 0, reason: 'epoch_boundary' },
    { rid: '00000004', saver: 'epochMicro', applied: false, bytesSaved: 0, reason: 'epoch_boundary' },
    { rid: '00000005', saver: 'epochAuto', applied: false, reason: 'window_pressure' },
    { rid: '00000006', saver: 'lingua', applied: false, reason: 'no_backend' },
    { rid: '00000007', saver: 'inject', applied: true, bytesSaved: 384 },
    { rid: '00000008', saver: 'rtk', applied: true },
  ].map((event, index) => ({ ts: Date.parse('2026-09-07T12:00:00.000Z') - (8 - index) * 60000, ...event })),
};
