import { beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ guard: vi.fn() }));
vi.mock('@/lib/admin/guard.js', () => ({ requireAdmin: auth.guard }));
import { GET, POST, PATCH, DELETE } from '@/app/api/admin/projects/[[...path]]/route.js';
import { getAdapter } from '@/lib/db/driver.js';
import { createApiKey } from '@/lib/db/repos/apiKeysRepo.js';
import { prepareContextCapture } from '@/lib/db/repos/contextEvidenceRepo.js';
import { saveRequestUsage } from '@/lib/db/repos/usageRepo.js';
const db = await getAdapter();
const ctx = (...path) => ({ params: Promise.resolve({ path }) });
const req = (path = '', method = 'GET', body) => new Request(`http://localhost/api/admin/projects${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => { auth.guard.mockResolvedValue(null); });
it('refuses a caller before reading any project mutation body', async () => {
  const denied = Response.json({ error: 'unauthorized' }, { status: 401 }); auth.guard.mockResolvedValue(denied);
  const read = vi.fn(); const request = { get body() { read(); throw new Error('must not read'); } };
  expect(await POST(request, ctx())).toBe(denied); expect(read).not.toHaveBeenCalled();
});
it('creates, persists, validates and rejects stale project policies through real repository handlers', async () => {
  const response = await POST(req('', 'POST', { name: 'API project', maxCompletionTokens: 100 }), ctx());
  expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
  const created = await response.json(), id = created.project.id;
  expect((await (await GET(req(`/${id}`), ctx(id))).json()).project.maxCompletionTokens).toBe(100);
  expect((await PATCH(req(`/${id}`, 'PATCH', { expectedRevision: 1, maxCompletionTokens: 200 }), ctx(id))).status).toBe(200);
  expect((await PATCH(req(`/${id}`, 'PATCH', { expectedRevision: 1, maxCompletionTokens: 300 }), ctx(id))).status).toBe(409);
  expect((await PATCH(req(`/${id}`, 'PATCH', { expectedRevision: 2, maxCompletionTokens: '200' }), ctx(id))).status).toBe(400);
  expect(db.get('SELECT maxCompletionTokens,revision FROM projects WHERE id=?', [id])).toEqual({ maxCompletionTokens: 200, revision: 2 });
});
it('binding and unbinding enforce exact observed identity and revision without leaking the key', async () => {
  const key = await createApiKey('API fixture key', 'isolated');
  const capture = await prepareContextCapture({ body: {}, apiKey: key.key, headers: new Headers({ 'x-tokenproxy-client-id': 'client', 'x-tokenproxy-project-id': 'project' }) });
  await saveRequestUsage({ apiKey: key.key, provider: 'fixture', model: 'model', contextTelemetry: { explicitIdentity: capture.identity, apiKeyId: key.id }, tokens: { prompt_tokens: 1, completion_tokens: 1 } });
  const { project } = await (await POST(req('', 'POST', { name: 'Bound API project' }), ctx())).json();
  const body = { expectedRevision: 1, apiKeyId: key.id, clientRef: capture.identity.clientRef, projectRef: capture.identity.projectRef };
  const bound = await (await POST(req(`/${project.id}/bindings`, 'POST', body), ctx(project.id, 'bindings'))).json();
  expect(bound.bindings).toHaveLength(1); expect(JSON.stringify(bound)).not.toContain(key.key);
  expect((await DELETE(req(`/${project.id}/bindings/${bound.bindings[0].id}`, 'DELETE', { expectedRevision: 1 }), ctx(project.id, 'bindings', bound.bindings[0].id))).status).toBe(409);
  expect(db.get('SELECT COUNT(*) AS n FROM projectBindings WHERE projectId=?', [project.id]).n).toBe(1);
  expect((await DELETE(req(`/${project.id}/bindings/${bound.bindings[0].id}`, 'DELETE', { expectedRevision: 2 }), ctx(project.id, 'bindings', bound.bindings[0].id))).status).toBe(200);
  expect(db.get('SELECT COUNT(*) AS n FROM projectBindings WHERE projectId=?', [project.id]).n).toBe(0);
});
it('bounds body reads independently of content length and rejects unknown fields and query dimensions', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM projects').n;
  expect((await POST(req('', 'POST', { name: 'x'.repeat(33000) }), ctx())).status).toBe(413);
  expect((await POST(req('', 'POST', { name: 'Bad policy', bypass: true }), ctx())).status).toBe(400);
  for (const query of ['?limit=1&limit=2', '?rawKey=true', '?limit=101', '?before='+ 'x'.repeat(129)]) expect((await GET(req(query), ctx())).status).toBe(400);
  expect(db.get('SELECT COUNT(*) AS n FROM projects').n).toBe(before);
});
