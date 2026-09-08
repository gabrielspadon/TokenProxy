import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: true, execute: state.execute }) }));
vi.mock('../../open-sse/rtk/headroom.js', async original => ({
  ...(await original()), compressWithHeadroom: async () => { throw new Error('Private fixture context'); },
}));
const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
const { getAdapter } = await import('@/lib/db/driver.js');
const { createRule, evaluateEnabledRules } = await import('@/lib/db/repos/notificationRulesRepo.js');
const { drainNotifications } = await import('@/lib/notifications/delivery.js');

it('links a real gateway transformation failure to an evaluated alert and one retained delivery', async () => {
  const db = await getAdapter();
  const now = Date.now(), start = new Date(now - 1000).toISOString();
  const config = { enabled: true, endpoints: [{ id: 'fixture', active: true,
    url: 'https://example.com/fixture', events: ['rule.fired'] }] };
  db.run('INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)', [JSON.stringify({ notifications: config })]);
  const rule = await createRule({ name: 'Failed shaping', conditionKind: 'compression_saver_failure',
    scopeKind: 'connection', scopeId: 'stage-fixture', threshold: 1, durationSeconds: 60, cooldownSeconds: 60 });
  state.execute.mockImplementation(async ({ body }) => ({ body, response: Response.json({
    id: 'fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 1 },
  }) }));
  const response = await handleChatCore({
    body: { model: 'claude-3-5-sonnet-20241022', stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'Synthetic request' }] },
    modelInfo: { provider: 'anthropic-compatible-audit', model: 'claude-3-5-sonnet-20241022' },
    credentials: { apiKey: 'fixture', sessionHash: 'e'.repeat(64) }, connectionId: 'stage-fixture',
    contextTelemetry: { logicalRequestId: 'notification-stage-fixture' }, contextStructureEnabled: false,
    headroomEnabled: true, headroomUrl: 'http://localhost:8787',
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  expect(response.success).toBe(true); await response.response.text();
  expect(state.execute).toHaveBeenCalledTimes(1);
  const stage = db.get("SELECT * FROM contextStages WHERE stage='headroom' AND outcome='failed'");
  expect(stage).toMatchObject({ outcomeSource: 'execution', errorCode: 'transform_exception' });
  const end = new Date(Date.now() + 1000).toISOString();
  const scan = await evaluateEnabledRules({ start, end, notBefore: start });
  expect(scan.fired).toBe(1);
  const alert = db.get('SELECT * FROM notificationRuleEvents WHERE ruleId=?', [rule.id]);
  expect(alert.evidence).toContain(stage.requestId);
  expect(alert.evidence).not.toContain('Private fixture');
  const send = vi.fn(async () => ({ ok: true, status: 204, attempts: 1 }));
  await drainNotifications({ db, config, send });
  await drainNotifications({ db, config, send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][2].alertId).toBe(alert.id);
  expect(db.get('SELECT state FROM notificationDeliveries WHERE eventId=?', [alert.id]).state).toBe('delivered');
});
