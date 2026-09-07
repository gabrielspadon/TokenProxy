// The route flattened every parse failure into one message, so an operator who
// mistyped a filter was told to fix their time range. The route had no test at
// all, which is how that reached production.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.requireAdmin }));

const { GET } = await import('../../src/app/api/admin/operations/events/route.js');

const call = (query) => GET(new Request(`http://127.0.0.1/api/admin/operations/events?${query}`));

beforeEach(() => mocks.requireAdmin.mockResolvedValue(null));

describe('operation events query errors name their cause', () => {
  it('says the filter is unsupported when the parameter is unknown', async () => {
    const response = await call('limit=5');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('invalid_query');
    expect(body.error).toMatch(/filter is not supported, or was given twice/);
    expect(body.error).not.toMatch(/range/);
  });

  it('says the same for a duplicated parameter', async () => {
    const body = await (await call('pageSize=5&pageSize=6')).json();
    expect(body.error).toMatch(/given twice/);
  });

  it('still points at the range when the range is what is malformed', async () => {
    const body = await (await call('start=2026-09-07T00:00:00Z&end=2026-09-01T00:00:00Z')).json();
    expect(body.error).toMatch(/valid operation history range/);
  });

  it('never echoes the caller input back in the message', async () => {
    const body = await (await call('drop%20table=1')).json();
    expect(body.error).not.toMatch(/drop/i);
  });
});
