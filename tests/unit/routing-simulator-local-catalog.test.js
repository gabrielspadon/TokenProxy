import { expect, it, vi } from 'vitest';
vi.mock('open-sse/services/kimchiModels.js', () => { throw new Error('Offline import must not load live Kimchi discovery'); });
vi.mock('@/app/api/providers/[id]/models/liveCatalog.js', () => { throw new Error('Offline import must not load live OpenAI/Codex discovery'); });
vi.mock('@/sse/services/tokenRefresh', () => { throw new Error('Offline import must not load credential refresh'); });
import { buildModelsList } from '@/app/api/v1/models/route.js';
it('imports and builds the persisted catalog without importing live provider discovery', async () => {
  const blocked = vi.fn(() => { throw new Error('Transport prohibited'); });
  vi.stubGlobal('fetch', blocked);
  try {
    const models = await buildModelsList(['llm'], { localOnly: true });
    expect(Array.isArray(models)).toBe(true);
    expect(blocked).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
