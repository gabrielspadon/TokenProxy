import { describe, expect, it, vi } from 'vitest';
import { handleComboChat } from '../../../open-sse/services/combo.js';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const body = { model: 'fixture-combo', messages: [{ role: 'user', content: 'Perform one transaction.' }] };
const run = (handleSingleModel) => handleComboChat({ body, models: ['codex/gpt-5.6-sol', 'anthropic/claude-opus-4-8'], handleSingleModel, log, comboName: 'audit', comboStrategy: 'fallback' });

describe('independent combo replay boundary', () => {
  it('does not assume replay is safe when failure evidence is absent', async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'uncertain' }, { status: 503 })).mockResolvedValue(Response.json({ choices: [{ message: { content: 'duplicate' } }] }));
    const response = await run(dispatch);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await response.text();
  });
  it.each([429, 503])('does not change models after an unsafe %i response', async (status) => {
    const first = Response.json({ error: 'partial generation' }, { status, headers: { 'x-tokenproxy-replay-safe': 'false' } });
    const dispatch = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(Response.json({ choices: [{ message: { content: 'duplicate' } }] }));
    const response = await run(dispatch);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('does not change models after accepted empty SSE', async () => {
    const first = new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const dispatch = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(Response.json({ choices: [{ message: { content: 'duplicate' } }] }));
    const response = await run(dispatch);
    expect(response.status).toBe(502);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('does not change models after an uncertain transport exception', async () => {
    const dispatch = vi.fn().mockRejectedValueOnce(new Error('connection lost after write')).mockResolvedValue(Response.json({ choices: [{ message: { content: 'duplicate' } }] }));
    const response = await run(dispatch);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await response.text();
  });

  it('preserves a certified client wait without rotating to another model', async () => {
    const dispatch = vi.fn().mockResolvedValue(Response.json({ error: 'busy pin' }, { status: 503,
      headers: { 'x-tokenproxy-replay-safe': 'false', 'x-should-retry': 'true', 'retry-after': '3' } }));
    const response = await run(dispatch);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-should-retry')).toBe('true');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(dispatch).toHaveBeenCalledTimes(1);
    await response.text();
  });
});
