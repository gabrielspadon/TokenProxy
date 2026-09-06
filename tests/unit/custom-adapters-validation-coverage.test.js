import { describe, expect, it } from 'vitest';
import {
  ADAPTER_FORMATS,
  compileCustomAdapter,
  adapterFromProviderNode,
  normalizeAdapterBaseUrl,
} from 'open-sse/providers/customAdapters.js';

const ID = 'openai-compatible-adapter-cov';

function valid(extra = {}) {
  return {
    name: 'Gateway',
    prefix: 'gw',
    baseUrl: 'https://gw.example/v1',
    ...extra,
  };
}

function errorsOf(doc, options = { id: ID }) {
  return compileCustomAdapter(doc, options).errors;
}

describe('compileCustomAdapter rejection paths', () => {
  it('rejects a non-object document', () => {
    expect(compileCustomAdapter(null).errors).toEqual(['Adapter must be a JSON object.']);
    expect(compileCustomAdapter([]).node).toBeNull();
  });

  it('rejects executable fields and function values', () => {
    const errs = errorsOf(valid({ transformer: 'x', script: {}, other: () => {} }));
    expect(errs.filter((e) => e.includes('is not supported'))).toHaveLength(2);
    expect(errs.some((e) => e.includes('"other" is a function'))).toBe(true);
  });

  it('rejects missing/oversized name and bad prefix, and a taken prefix', () => {
    expect(errorsOf(valid({ name: '' })).some((e) => e.includes('"name" is required'))).toBe(true);
    expect(errorsOf(valid({ name: 'x'.repeat(129) })).some((e) => e.includes('128'))).toBe(true);
    expect(errorsOf(valid({ prefix: 'bad prefix!' })).some((e) => e.includes('"prefix"'))).toBe(
      true
    );
    const taken = errorsOf(valid(), { id: ID, takenPrefixes: ['gw'] });
    expect(taken.some((e) => e.includes('already used'))).toBe(true);
  });

  it('rejects a non-http(s) or missing baseUrl', () => {
    expect(errorsOf(valid({ baseUrl: 'ftp://x.example' }))[0]).toMatch(/absolute http\(s\) URL/);
    expect(errorsOf(valid({ baseUrl: undefined }))[0]).toMatch(/"baseUrl"/);
    expect(errorsOf(valid({ baseUrl: 'not a url' }))[0]).toMatch(/"baseUrl"/);
  });

  it('validates headers: shape, count, name, reserved, type, size, newline, interpolation', () => {
    expect(errorsOf(valid({ headers: [] }))[0]).toMatch(/object of name\/value strings/);

    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`h-${i}`, 'v']));
    expect(errorsOf(valid({ headers: many }))[0]).toMatch(/at most 32/);

    const errs = errorsOf(
      valid({
        headers: {
          'bad name': 'v',
          host: 'v',
          'x-num': 5,
          'x-big': 'v'.repeat(4097),
          'x-crlf': 'a\r\nb',
          'x-env': '${SECRET}',
          'x-env2': '$API_KEY_SECRET',
          'x-ok': 'value with space',
        },
      })
    );
    expect(errs.some((e) => e.includes('not a valid HTTP token'))).toBe(true);
    expect(errs.some((e) => e.includes('managed by the transport'))).toBe(true);
    expect(errs.some((e) => e.includes('must be a string'))).toBe(true);
    expect(errs.some((e) => e.includes('exceeds 4096'))).toBe(true);
    expect(errs.some((e) => e.includes('newline or NUL'))).toBe(true);
    expect(errs.filter((e) => e.includes('environment interpolation'))).toHaveLength(2);
    expect(errs.every((e) => !e.includes('x-ok'))).toBe(true);
  });

  it('validates auth: shape, header token, reserved header, scheme', () => {
    expect(errorsOf(valid({ auth: 'bearer' }))[0]).toMatch(/"auth" must be an object/);
    expect(errorsOf(valid({ auth: { header: 'bad header' } }))[0]).toMatch(/valid HTTP token/);
    expect(errorsOf(valid({ auth: { header: 'Host' } }))[0]).toMatch(/cannot be "Host"/);
    expect(errorsOf(valid({ auth: { header: 'x-key', scheme: 'digest' } }))[0]).toMatch(
      /"bearer" or "raw"/
    );
  });

  it('validates endpoints: array shape, entry shape, format, duplicates, url, urlSuffix', () => {
    expect(errorsOf(valid({ endpoints: [] }))[0]).toMatch(/non-empty array/);
    expect(errorsOf(valid({ endpoints: 'x' }))[0]).toMatch(/non-empty array/);
    const errs = errorsOf(
      valid({
        endpoints: [
          'junk',
          { format: 'grpc' },
          { format: ADAPTER_FORMATS[0] },
          { format: ADAPTER_FORMATS[0] },
          { format: ADAPTER_FORMATS[1], url: 'not-a-url' },
          { format: ADAPTER_FORMATS[2], urlSuffix: 'has space' },
        ],
      })
    );
    expect(errs.some((e) => e.includes('must be an object'))).toBe(true);
    expect(errs.some((e) => e.includes('"grpc"'))).toBe(true);
    expect(errs.some((e) => e.includes('more than once'))).toBe(true);
    expect(errs.some((e) => e.includes('invalid url'))).toBe(true);
    expect(errs.some((e) => e.includes('invalid urlSuffix'))).toBe(true);
  });

  it('reports endpoints resolving to nothing when only invalid entries survive validation without errors', () => {
    // No baseUrl error is emitted when endpoints are declared, but an endpoint
    // without a url cannot resolve without baseUrl; result is empty output.
    const { errors, node } = compileCustomAdapter(
      { name: 'n', prefix: 'p', endpoints: [{ format: ADAPTER_FORMATS[0] }] },
      { id: ID }
    );
    expect(node).toBeNull();
    expect(errors.some((e) => e.includes('resolved to nothing'))).toBe(true);
  });
});

describe('compileCustomAdapter success paths', () => {
  it('compiles per-endpoint auth defaults from the format table and hoists headers', () => {
    const { errors, node } = compileCustomAdapter(
      valid({
        headers: { 'x-tenant': 't1' },
        endpoints: ADAPTER_FORMATS.map((format) => ({ format })),
      }),
      { id: ID }
    );
    expect(errors).toEqual([]);
    expect(node.transports).toHaveLength(ADAPTER_FORMATS.length);
    for (const t of node.transports) {
      expect(t.headers).toEqual({ 'x-tenant': 't1' });
      expect(t.auth).toBeTruthy();
      expect(t.baseUrl.startsWith('https://gw.example/v1/')).toBe(true);
    }
    expect(node.apiType).toBe('chat');
  });

  it('uses declared auth on every transport and honours anthropicVersion', () => {
    const { node } = compileCustomAdapter(
      valid({
        auth: { header: 'x-api-key', scheme: 'raw', anthropicVersion: true },
        endpoints: [{ format: ADAPTER_FORMATS[1] }],
      }),
      { id: ID }
    );
    expect(node.transports[0].auth).toEqual({
      combined: true,
      header: 'x-api-key',
      scheme: 'raw',
      anthropicVersion: true,
    });
    expect(node.apiType).toBe('responses');
  });

  it('falls back apiType to chat when neither chat nor responses formats are declared', () => {
    const claudeOnly = ADAPTER_FORMATS.find((f) => f === 'claude');
    const { node } = compileCustomAdapter(valid({ endpoints: [{ format: claudeOnly }] }), {
      id: ID,
    });
    expect(node.apiType).toBe('chat');
  });

  it('derives node baseUrl from the first endpoint url when no baseUrl was given', () => {
    const { errors, node } = compileCustomAdapter(
      {
        name: 'n',
        prefix: 'p',
        endpoints: [
          {
            format: ADAPTER_FORMATS[0],
            url: 'https://api.example/v9/chat/completions/',
            urlSuffix: '?beta=1',
          },
        ],
      },
      { id: ID }
    );
    expect(errors).toEqual([]);
    expect(node.baseUrl).toBe('https://api.example/v9');
    expect(node.transports[0].urlSuffix).toBe('?beta=1');
  });
});

describe('normalizeAdapterBaseUrl', () => {
  it('strips trailing slashes and pasted canonical paths case-insensitively', () => {
    expect(normalizeAdapterBaseUrl('https://x.example/v1/')).toBe('https://x.example/v1');
    expect(normalizeAdapterBaseUrl('https://x.example/v1/Chat/Completions')).toBe(
      'https://x.example/v1'
    );
    expect(normalizeAdapterBaseUrl('https://x.example/v1/responses/')).toBe('https://x.example/v1');
    expect(normalizeAdapterBaseUrl(42)).toBe('');
  });
});

describe('adapterFromProviderNode', () => {
  it('returns null for a non-object and round-trips a compiled node', () => {
    expect(adapterFromProviderNode(null)).toBeNull();
    const { node } = compileCustomAdapter(
      valid({
        headers: { 'x-tenant': 't' },
        auth: { header: 'x-api-key', scheme: 'raw' },
      }),
      { id: ID }
    );
    const doc = adapterFromProviderNode(node);
    expect(doc.prefix).toBe('gw');
    expect(doc.headers).toEqual({ 'x-tenant': 't' });
    expect(doc.auth).toEqual({ header: 'x-api-key', scheme: 'raw' });
    // Re-compile of the exported doc succeeds
    const second = compileCustomAdapter(doc, { id: ID });
    expect(second.errors).toEqual([]);
  });

  it('tolerates a node without transports', () => {
    const doc = adapterFromProviderNode({ id: 'n1' });
    expect(doc.endpoints).toEqual([]);
    expect(doc.headers).toBeUndefined();
    expect(doc.auth).toBeUndefined();
  });
});
