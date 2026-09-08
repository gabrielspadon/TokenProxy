// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

vi.mock('@/shared/hooks/useEventStream', () => ({ useEventStream: () => ({ status: 'live', lastDataAt: null }) }));
const { default: TranslationPage } = await import('@/app/dashboard/translation/page.js');
let root, container, fetchMock, readback, saved;
beforeEach(async () => {
  saved = null; readback = null;
  fetchMock = vi.fn(async (url, init) => {
    if (url === '/api/translator/save') { saved = JSON.parse(init.body); return Response.json({ success: true }); }
    if (url.startsWith('/api/translator/load?')) return readback ? readback() : Response.json({ success: true, content: saved.content });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><TranslationPage /></MantineProvider>));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function save() {
  const area = [...container.querySelectorAll('label')].find(el => el.textContent.includes('Snapshot content, as JSON')).querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '{"synthetic":true}');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => [...container.querySelectorAll('#h-snapshots ~ * button')].find(el => el.textContent.trim() === 'Save').click());
}
it('verifies saved snapshot content by a separate load without sending any model request', async () => {
  await save();
  expect(saved).toEqual({ file: '1_req_client.json', content: '{"synthetic":true}' });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/translator/save', '/api/translator/load?file=1_req_client.json']);
  expect(container.textContent).toContain('Saved and read back');
});
it.each(['missing', 'changed'])('keeps an accepted snapshot %s readback uncertain without retry', async state => {
  readback = () => state === 'missing' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ success: true, content: 'different' });
  await save();
  expect(container.textContent).toContain('stored content was not verified');
  expect(container.textContent).not.toContain('Saved and read back');
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/translator/save')).toHaveLength(1);
});
