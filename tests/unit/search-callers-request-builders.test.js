// Search request builders (open-sse/handlers/search/callers.js): per-provider
// URL and body shape, credential requirements thrown before any network call,
// and the SSRF guard firing ONLY on the client-supplied baseUrl (#1231).
import { describe, it, expect, vi } from 'vitest';

const ssrf = vi.hoisted(() => ({ assertPublicUrl: vi.fn() }));
vi.mock('../../src/shared/utils/ssrfGuard.js', () => ssrf);

import {
  parseDomainFilter,
  getProviderSetting,
  resolveBaseUrl,
  toPageNumber,
  buildSearchRequest,
} from 'open-sse/handlers/search/callers.js';

const P = (id, baseUrl = 'https://api.example.com/v1') => ({ id, baseUrl });
const params = (over = {}) => ({
  query: 'q',
  searchType: 'web',
  maxResults: 5,
  token: 'tok',
  ...over,
});

describe('helpers', () => {
  it('parseDomainFilter splits includes and dash-prefixed excludes', () => {
    expect(parseDomainFilter(['a.com', '-b.com', 'c.com'])).toEqual({
      includes: ['a.com', 'c.com'],
      excludes: ['b.com'],
    });
    expect(parseDomainFilter()).toEqual({ includes: [], excludes: [] });
    expect(parseDomainFilter([])).toEqual({ includes: [], excludes: [] });
  });

  it('getProviderSetting prefers providerOptions, falls back to providerSpecificData, ignores non-strings and blanks', () => {
    const p = params({
      providerOptions: { cx: ' from-options ', blank: '  ', num: 7 },
      providerSpecificData: { cx: 'from-data', blank: 'data-blank', num: 'data-num' },
    });
    expect(getProviderSetting(p, 'cx')).toBe('from-options');
    expect(getProviderSetting(p, 'blank')).toBe('data-blank');
    expect(getProviderSetting(p, 'num')).toBe('data-num');
    expect(getProviderSetting(p, 'missing')).toBeUndefined();
  });

  it('toPageNumber converts offset to a 1-indexed page and rejects nonsense', () => {
    expect(toPageNumber(10, 5)).toBe(3);
    expect(toPageNumber(0, 5)).toBeUndefined();
    expect(toPageNumber(undefined, 5)).toBeUndefined();
    expect(toPageNumber(10, 0)).toBeUndefined();
  });
});

describe('resolveBaseUrl and the SSRF boundary', () => {
  it('no override returns the config baseUrl with trailing slashes stripped, no guard call', () => {
    ssrf.assertPublicUrl.mockClear();
    expect(resolveBaseUrl({ id: 'x', baseUrl: 'https://a.com/v1///' }, params())).toBe(
      'https://a.com/v1'
    );
    expect(ssrf.assertPublicUrl).not.toHaveBeenCalled();
  });

  it('client providerOptions.baseUrl IS guarded; admin providerSpecificData.baseUrl is NOT (#1231)', () => {
    ssrf.assertPublicUrl.mockClear();
    resolveBaseUrl(P('x'), params({ providerOptions: { baseUrl: 'https://pub.example/' } }));
    expect(ssrf.assertPublicUrl).toHaveBeenCalledWith('https://pub.example/');

    ssrf.assertPublicUrl.mockClear();
    const out = resolveBaseUrl(
      P('x'),
      params({ providerSpecificData: { baseUrl: 'http://192.168.1.5:8080/searxng/' } })
    );
    expect(out).toBe('http://192.168.1.5:8080/searxng');
    expect(ssrf.assertPublicUrl).not.toHaveBeenCalled();
  });

  it('a malformed or non-http override throws instead of silently falling back', () => {
    expect(() =>
      resolveBaseUrl(P('x'), params({ providerOptions: { baseUrl: 'not a url' } }))
    ).toThrow(/Invalid baseUrl/);
    expect(() =>
      resolveBaseUrl(P('x'), params({ providerOptions: { baseUrl: 'ftp://a.com' } }))
    ).toThrow(/Invalid baseUrl protocol/);
  });
});

describe('credential requirements throw before any request is built', () => {
  it.each([
    ['google-pse', {}, /apiKey and cx/],
    ['linkup', {}, /API key/],
    ['searchapi', {}, /API key/],
    ['youcom', {}, /API key/],
    ['xquik', {}, /API key/],
  ])('%s without a token throws', (id, extra, re) => {
    expect(() => buildSearchRequest(P(id), params({ token: undefined, ...extra }))).toThrow(re);
  });

  it('google-pse with a token but no cx still throws', () => {
    expect(() => buildSearchRequest(P('google-pse'), params())).toThrow(/cx/);
  });

  it('xquik rejects an invalid queryType', () => {
    expect(() =>
      buildSearchRequest(P('xquik'), params({ providerOptions: { queryType: 'Newest' } }))
    ).toThrow(/Latest or Top/);
  });
});

describe('per-provider request shape', () => {
  it('serper: news endpoint, gl lowercased, hl, POST with X-API-Key', () => {
    const { url, init } = buildSearchRequest(
      P('serper', 'https://google.serper.dev'),
      params({ searchType: 'news', country: 'US', language: 'en' })
    );
    expect(url).toBe('https://google.serper.dev/news');
    expect(init.headers['X-API-Key']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ q: 'q', num: 5, gl: 'us', hl: 'en' });
  });

  it('brave: GET with count and X-Subscription-Token; news switches the path', () => {
    const { url, init } = buildSearchRequest(P('brave-search'), params({ searchType: 'news' }));
    const u = new URL(url);
    expect(u.pathname.endsWith('/news/search')).toBe(true);
    expect(u.searchParams.get('count')).toBe('5');
    expect(init.headers['X-Subscription-Token']).toBe('tok');
  });

  it('google-pse: num capped at 10, dateRestrict mapped, start capped at 91, key+cx in query', () => {
    const { url } = buildSearchRequest(
      P('google-pse'),
      params({
        maxResults: 50,
        offset: 200,
        timeRange: 'week',
        providerOptions: { cx: 'cx-1' },
      })
    );
    const u = new URL(url);
    expect(u.searchParams.get('num')).toBe('10');
    expect(u.searchParams.get('dateRestrict')).toBe('w1');
    expect(u.searchParams.get('start')).toBe('91');
    expect(u.searchParams.get('key')).toBe('tok');
    expect(u.searchParams.get('cx')).toBe('cx-1');
  });

  it('linkup: depth whitelisted with standard fallback; timeRange becomes fromDate/toDate', () => {
    const bad = buildSearchRequest(
      P('linkup'),
      params({ providerOptions: { depth: 'ultra' }, timeRange: 'week' })
    );
    const body = JSON.parse(bad.init.body);
    expect(body.depth).toBe('standard');
    expect(body.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(body.toDate) - new Date(body.fromDate)).toBe(7 * 86400000);

    const deep = buildSearchRequest(P('linkup'), params({ providerOptions: { depth: 'deep' } }));
    expect(JSON.parse(deep.init.body).depth).toBe('deep');
  });

  it('exa: domain filter split into includeDomains/excludeDomains, news category', () => {
    const { init } = buildSearchRequest(
      P('exa'),
      params({ searchType: 'news', domainFilter: ['a.com', '-b.com'] })
    );
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      includeDomains: ['a.com'],
      excludeDomains: ['b.com'],
      category: 'news',
      text: true,
      highlights: true,
    });
  });

  it('searxng: /search appended once, page number from offset, json format', () => {
    const a = buildSearchRequest(
      P('searxng', 'https://sx.example'),
      params({ offset: 10, maxResults: 5 })
    );
    const ua = new URL(a.url);
    expect(ua.pathname).toBe('/search');
    expect(ua.searchParams.get('pageno')).toBe('3');
    expect(ua.searchParams.get('format')).toBe('json');

    const b = buildSearchRequest(P('searxng', 'https://sx.example/search'), params());
    expect(new URL(b.url).pathname).toBe('/search');
  });

  it('ddgs: strips an endpoint-shaped base, region needs BOTH halves, year timelimit excluded on news', () => {
    const { url, init } = buildSearchRequest(
      P('ddgs', 'https://sx.example/search'),
      params({ country: 'US', language: 'EN', timeRange: 'year', searchType: 'news' })
    );
    expect(url).toBe('https://sx.example/search/news');
    const body = JSON.parse(init.body);
    expect(body.region).toBe('us-en');
    expect(body).not.toHaveProperty('timelimit');

    const text = buildSearchRequest(
      P('ddgs', 'https://d.example'),
      params({ country: 'US', timeRange: 'year' })
    );
    const tb = JSON.parse(text.init.body);
    expect(text.url).toBe('https://d.example/search/text');
    expect(tb.timelimit).toBe('y');
    expect(tb).not.toHaveProperty('region'); // language missing → no region
  });

  it('glm: JSON-RPC tools/call envelope with search_query and count', () => {
    const { init } = buildSearchRequest(P('glm'), params({ maxResults: 7 }));
    const body = JSON.parse(init.body);
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({
      name: 'web_search_prime',
      arguments: { search_query: 'q', count: 7 },
    });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('youcom: count capped at 100, offset converted to page-offset capped at 9, livecrawl from contentOptions', () => {
    const { url } = buildSearchRequest(
      P('youcom'),
      params({
        maxResults: 500,
        offset: 5000,
        contentOptions: { full_page: true, format: 'markdown' },
      })
    );
    const u = new URL(url);
    expect(u.searchParams.get('count')).toBe('100');
    expect(u.searchParams.get('offset')).toBe('9');
    expect(u.searchParams.get('livecrawl')).toBe('web');
    expect(u.searchParams.get('livecrawl_formats')).toBe('markdown');
  });

  it('unknown provider falls back to generic bearer POST with the unified body', () => {
    const { url, init } = buildSearchRequest(
      { id: 'brand-new', baseUrl: 'https://n.example/api' },
      params()
    );
    expect(url).toBe('https://n.example/api');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ query: 'q', max_results: 5, search_type: 'web' });
  });
});
