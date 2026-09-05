// Search normalizers: every provider payload — realistic or malformed — must
// yield the well-formed { results, totalResults } shape without throwing,
// because a throw here kills the /v1/search request mid-flight.
import { describe, it, expect } from 'vitest';
import { normalizeSearchResponse } from 'open-sse/handlers/search/normalizers.js';

const PROVIDERS = [
  'serper',
  'brave-search',
  'perplexity',
  'exa',
  'tavily',
  'google-pse',
  'linkup',
  'searchapi',
  'youcom',
  'searxng',
  'ddgs',
  'ollama-search',
  'glm',
  'xquik',
];

describe('malformed payloads never throw and always return the unified shape', () => {
  const malformed = [
    ['empty object', {}],
    ['results as string', { results: 'nope' }],
    ['results as object', { results: { web: 'nope' } }],
    [
      'null-ish nested fields',
      { results: [], organic: null, news: null, items: null, tweets: null },
    ],
  ];
  for (const provider of PROVIDERS) {
    for (const [label, payload] of malformed) {
      it(`${provider}: ${label}`, () => {
        const out = normalizeSearchResponse(provider, payload, 'q', 'web');
        expect(Array.isArray(out.results)).toBe(true);
        expect(out.results).toHaveLength(0);
        expect(out).toHaveProperty('totalResults');
      });
    }
  }

  it('unknown provider id returns the empty shape', () => {
    expect(normalizeSearchResponse('mystery', { results: [{ url: 'x' }] }, 'q', 'web')).toEqual({
      results: [],
      totalResults: null,
    });
  });
});

describe('unified result shape invariants', () => {
  it('serper web: maps link→url, 1-based positions, strips scheme for display_url', () => {
    const out = normalizeSearchResponse(
      'serper',
      {
        organic: [
          {
            title: 'A',
            link: 'https://www.example.com/path?utm=1',
            snippet: 's',
            date: '2026-01-01',
          },
          { title: 'B', link: 'https://b.com' },
        ],
        searchParameters: { totalResults: 2 },
      },
      'q',
      'web'
    );
    expect(out.results[0]).toMatchObject({
      title: 'A',
      url: 'https://www.example.com/path?utm=1',
      display_url: 'example.com/path',
      snippet: 's',
      position: 1,
      published_at: '2026-01-01',
    });
    expect(out.results[1].position).toBe(2);
    expect(out.totalResults).toBe(2);
  });

  it('serper news type reads the news array, not organic', () => {
    const out = normalizeSearchResponse(
      'serper',
      {
        organic: [{ title: 'web', link: 'https://w.com' }],
        news: [{ title: 'news', link: 'https://n.com' }],
      },
      'q',
      'news'
    );
    expect(out.results.map((r) => r.title)).toEqual(['news']);
  });

  it('score is clamped to [0,1] and null when absent (exa)', () => {
    const out = normalizeSearchResponse(
      'exa',
      {
        results: [
          { url: 'https://a.com', score: 3.7 },
          { url: 'https://b.com', score: -1 },
          { url: 'https://c.com' },
        ],
      },
      'q',
      'web'
    );
    expect(out.results.map((r) => r.score)).toEqual([1, 0, null]);
  });

  it('exa full text lands in content with its length; snippet prefers highlights', () => {
    const out = normalizeSearchResponse(
      'exa',
      { results: [{ url: 'https://a.com', text: 'full body text', highlights: ['highlighted'] }] },
      'q',
      'web'
    );
    expect(out.results[0].snippet).toBe('highlighted');
    expect(out.results[0].content).toEqual({ format: 'text', text: 'full body text', length: 14 });
  });

  it('google-pse parses the string totalResults; garbage becomes null, not NaN', () => {
    const items = [{ title: 't', link: 'https://g.com', snippet: 's' }];
    expect(
      normalizeSearchResponse(
        'google-pse',
        { items, searchInformation: { totalResults: '1200' } },
        'q',
        'web'
      ).totalResults
    ).toBe(1200);
    expect(
      normalizeSearchResponse(
        'google-pse',
        { items, searchInformation: { totalResults: 'many' } },
        'q',
        'web'
      ).totalResults
    ).toBeNull();
  });

  it('brave: web vs news containers, favicon from meta_url', () => {
    const data = {
      web: {
        results: [
          {
            title: 'w',
            url: 'https://w.com',
            description: 'd',
            meta_url: { favicon: 'https://f.ico' },
          },
        ],
        totalCount: 4,
      },
      news: { results: [{ title: 'n', url: 'https://n.com', age: '1d' }] },
    };
    const web = normalizeSearchResponse('brave-search', data, 'q', 'web');
    expect(web.results[0]).toMatchObject({
      title: 'w',
      snippet: 'd',
      favicon_url: 'https://f.ico',
    });
    expect(web.totalResults).toBe(4);
    const news = normalizeSearchResponse('brave-search', data, 'q', 'news');
    expect(news.results[0]).toMatchObject({ title: 'n', published_at: '1d' });
  });

  it('ddgs maps href→url and body→snippet', () => {
    const out = normalizeSearchResponse(
      'ddgs',
      { results: [{ title: 't', href: 'https://d.com', body: 'b' }] },
      'q',
      'web'
    );
    expect(out.results[0]).toMatchObject({ url: 'https://d.com', snippet: 'b' });
  });

  it('glm unwraps the MCP text envelope; unparseable envelope text yields empty results, not a throw', () => {
    const good = normalizeSearchResponse(
      'glm',
      {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  { title: 't', link: 'https://z.com', content: 'c', publish_date: '2026-01-02' },
                ],
              }),
            },
          ],
        },
      },
      'q',
      'web'
    );
    expect(good.results[0]).toMatchObject({
      url: 'https://z.com',
      snippet: 'c',
      published_at: '2026-01-02',
    });

    const bad = normalizeSearchResponse(
      'glm',
      {
        result: { content: [{ type: 'text', text: '{broken' }] },
      },
      'q',
      'web'
    );
    expect(bad.results).toEqual([]);
  });

  it('ollama-search accepts both { results: [] } and a bare array', () => {
    const item = { title: 't', url: 'https://o.com', content: 'c' };
    expect(
      normalizeSearchResponse('ollama-search', { results: [item] }, 'q', 'web').results
    ).toHaveLength(1);
    expect(normalizeSearchResponse('ollama-search', [item], 'q', 'web').results).toHaveLength(1);
  });

  it('xquik builds x.com URLs, keeps pagination, and tolerates missing author/media', () => {
    const out = normalizeSearchResponse(
      'xquik',
      {
        tweets: [
          {
            id: '123',
            author: { username: 'gab' },
            text: 'hello',
            createdAt: '2026-09-01T00:00:00Z',
            media: [{ mediaUrl: 'https://img.x/1.jpg' }],
          },
          { id: '456', text: 'anon' },
        ],
        has_next_page: true,
        next_cursor: 'cur-2',
      },
      'q',
      'web'
    );
    expect(out.results[0]).toMatchObject({
      title: '@gab on X',
      url: 'https://x.com/gab/status/123',
      snippet: 'hello',
      metadata: expect.objectContaining({ author: '@gab', image_url: 'https://img.x/1.jpg' }),
    });
    expect(out.results[1].url).toBe('https://x.com/i/web/status/456');
    expect(out.pagination).toEqual({ has_more: true, next_cursor: 'cur-2' });
  });

  it('youcom: snippet from first string in snippets[], livecrawl markdown lands as content', () => {
    const out = normalizeSearchResponse(
      'youcom',
      {
        results: {
          web: [{ title: 't', url: 'https://y.com', snippets: [null, 'snip'], markdown: '# body' }],
        },
      },
      'q',
      'web'
    );
    expect(out.results[0].snippet).toBe('snip');
    expect(out.results[0].content).toEqual({ format: 'markdown', text: '# body', length: 6 });
  });

  it("an item missing its url still yields a result with url '' and no display_url (stream survives)", () => {
    const out = normalizeSearchResponse('tavily', { results: [{ title: 'no url' }] }, 'q', 'web');
    expect(out.results[0].url).toBe('');
    expect(out.results[0].display_url).toBeUndefined();
  });
});
