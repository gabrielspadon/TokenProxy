import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ deny: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: mocks.deny }));
vi.mock('@/lib/db/repos/quotaCheckQueue.js', () => ({ getQuotaCheckQueue: async () => ({ list: mocks.list }) }));
import { GET } from '@/app/api/admin/quota/schedule/route.js';
beforeEach(() => { mocks.deny.mockReset(); mocks.list.mockReset(); mocks.list.mockReturnValue({ items:[],total:0 }); });
it('protects schedule evidence before database access', async () => {
  mocks.deny.mockResolvedValue(new Response('Unauthorized',{status:401}));
  expect((await GET(new Request('http://localhost/api/admin/quota/schedule'))).status).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it('passes exact account and pagination to the durable queue without triggering any execution',async () => {
  const response = await GET(new Request('http://localhost/api/admin/quota/schedule?connectionId=account-one&page=2&pageSize=10'));
  expect(response.status).toBe(200);
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith({connectionId:'account-one',page:2,pageSize:10});
  expect((await response.json()).purpose).toContain('Metadata checks');
});
it.each(['unexpected=1','page=1&page=2','page=0','page=','page=1e2','pageSize=0x10','pageSize=-1','page=1.2'])('refuses ambiguous query %s',async query => {
  expect((await GET(new Request(`http://localhost/api/admin/quota/schedule?${query}`))).status).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled();
});
it('reports database failure as unavailable',async () => {
  mocks.list.mockImplementation(() => {throw new Error('offline');});
  expect((await GET(new Request('http://localhost/api/admin/quota/schedule'))).status).toBe(503);
});
