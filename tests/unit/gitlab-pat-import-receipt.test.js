import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/models', () => ({ createProviderConnection: vi.fn(async input => ({ ...input, id: 'fixture-gitlab' })) }));
import { POST } from '@/app/api/oauth/gitlab/pat/route';
import { createProviderConnection } from '@/models';
afterEach(() => vi.restoreAllMocks());
it('returns the exact created GitLab account identity for readback without echoing its credential', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ email: 'fixture@example.invalid', username: 'fixture-user' }));
  const request = new Request('http://localhost/api/oauth/gitlab/pat', { method: 'POST', body: JSON.stringify({ token: 'fixture-token', baseUrl: 'https://fixture.invalid' }) });
  const response = await POST(request), body = await response.json();
  expect(body).toEqual({ success: true, connection: { id: 'fixture-gitlab', provider: 'gitlab', email: 'fixture@example.invalid' } });
  expect(createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fixture-token', providerSpecificData: expect.objectContaining({ baseUrl: 'https://fixture.invalid' }) }));
  expect(JSON.stringify(body)).not.toContain('fixture-token');
});
