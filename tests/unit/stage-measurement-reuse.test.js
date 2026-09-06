import { afterEach, expect, it, vi } from 'vitest';
const observed = vi.hoisted(() => ({ ledger: null, outbound: null }));
vi.mock('../../open-sse/executors/index.js', () => ({ getExecutor: () => ({ noAuth: true,
  async execute({ body }) {
    observed.outbound = body;
    return { response: Response.json({ choices: [{ message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 } }) };
  },
}) }));
vi.mock('../../open-sse/handlers/chatCore/contextTelemetry.js', async original => ({
  ...await original(),
  async recordContextAttempt(context) { observed.ledger = context.stages; },
  async recordContextFailure() {},
}));
const { handleChatCore } = await import('../../open-sse/handlers/chatCore.js');
afterEach(() => vi.restoreAllMocks());
it('retains disabled byte stages and final size without serializing those stages', async () => {
  const text = 'Preserve unicode 日本語 🧭 and exact tool result 900719925474099312345. '.repeat(2000);
  const body = { model: 'gpt-4o', messages: [{ role: 'user', content: text }], stream: false };
  const stringify = JSON.stringify;
  let stageSerializations = 0;
  vi.spyOn(JSON, 'stringify').mockImplementation(function (...args) {
    if (args[0]?.messages?.[0]?.content === text && new Error().stack?.includes('measureSaverStage')) stageSerializations++;
    return Reflect.apply(stringify, JSON, args);
  });
  const response = await handleChatCore({ body, modelInfo: { provider: 'openrouter', model: 'gpt-4o' }, credentials: {},
    connectionId: 'stage-fixture', clientRawRequest: { headers: {}, endpoint: '/v1/chat/completions' },
    log: { debug() {}, info() {}, warn() {}, error() {} } });
  await response.response.text();
  expect(response.success).toBe(true);
  expect(stageSerializations).toBe(0);
  expect(observed.outbound.messages[0].content).toBe(text);
  const disabled = observed.ledger.filter(stage => !stage.ran);
  expect(disabled.map(stage => stage.stage)).toEqual(['schema', 'thinking', 'rtk', 'privacy', 'inject', 'pxpipe', 'mem', 'headroom', 'qac', 'pairs', 'reorder']);
  for (const stage of disabled) expect(stage).toMatchObject({ delta: 0, in: stage.out, ran: false });
  expect(observed.ledger.at(-1).out).toBe(Buffer.byteLength(stringify(observed.outbound)));
  expect(observed.ledger.reduce((sum, stage) => sum + stage.delta, 0)).toBe(observed.ledger.at(-1).out - observed.ledger[0].in);
  expect(body.messages[0].content).toBe(text);
});
