// Gemini translator format helpers: content-to-parts conversion, text
// extraction, function-response key sanitization, id generators, and the
// schema-cleaning phases not exercised by the incident-specific suites.
import { describe, it, expect } from 'vitest';
import {
  convertOpenAIContentToParts,
  extractTextContent,
  sanitizeFunctionResponseResult,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity,
  UNSUPPORTED_SCHEMA_CONSTRAINTS,
  DEFAULT_SAFETY_SETTINGS,
} from 'open-sse/translator/formats/gemini.js';

describe('convertOpenAIContentToParts', () => {
  it('wraps a plain string as one text part', () => {
    expect(convertOpenAIContentToParts('hello')).toEqual([{ text: 'hello' }]);
  });

  it('returns no parts for non-string non-array content', () => {
    expect(convertOpenAIContentToParts(null)).toEqual([]);
    expect(convertOpenAIContentToParts({ nope: true })).toEqual([]);
  });

  it('converts text and data-URI image blocks', () => {
    const parts = convertOpenAIContentToParts([
      { type: 'text', text: 't' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(parts).toEqual([
      { text: 't' },
      { inlineData: { mime_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('converts an http(s) image URL to fileData', () => {
    const parts = convertOpenAIContentToParts([
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
    ]);
    expect(parts).toEqual([
      { fileData: { fileUri: 'https://example.com/img.png', mimeType: 'image/*' } },
    ]);
  });

  it('converts AI SDK image parts, data URI and http variants', () => {
    const parts = convertOpenAIContentToParts([
      { type: 'image', image: 'data:image/jpeg;base64,BBBB' },
      { type: 'image', image: 'https://example.com/pic.jpg' },
    ]);
    expect(parts[0]).toEqual({ inlineData: { mime_type: 'image/jpeg', data: 'BBBB' } });
    expect(parts[1]).toEqual({
      fileData: { fileUri: 'https://example.com/pic.jpg', mimeType: 'image/*' },
    });
  });

  it('converts input_audio with mp3 mapped to audio/mpeg and default wav', () => {
    const parts = convertOpenAIContentToParts([
      { type: 'input_audio', input_audio: { data: 'AB', format: 'mp3' } },
      { type: 'input_audio', input_audio: { data: 'CD' } },
    ]);
    expect(parts[0].inlineData.mime_type).toBe('audio/mpeg');
    expect(parts[1].inlineData.mime_type).toBe('audio/wav');
  });

  it('converts audio_url and file data URIs to inlineData', () => {
    const parts = convertOpenAIContentToParts([
      { type: 'audio_url', audio_url: { url: 'data:audio/ogg;base64,EE' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,FF' } },
    ]);
    expect(parts[0]).toEqual({ inlineData: { mime_type: 'audio/ogg', data: 'EE' } });
    expect(parts[1]).toEqual({ inlineData: { mime_type: 'application/pdf', data: 'FF' } });
  });

  it('drops unrecognized blocks', () => {
    expect(convertOpenAIContentToParts([{ type: 'mystery' }])).toEqual([]);
  });
});

describe('extractTextContent', () => {
  it('passes a string through', () => {
    expect(extractTextContent('s')).toBe('s');
  });

  it('joins text blocks with the separator and ignores other blocks', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'https://x' } },
      { type: 'text', text: 'b' },
    ];
    expect(extractTextContent(content, '\n')).toBe('a\nb');
  });

  it('returns empty string for anything else', () => {
    expect(extractTextContent(42)).toBe('');
  });
});

describe('sanitizeFunctionResponseResult / tryParseJSON', () => {
  it('rewrites keys with $ # / and definitions, recursively and in arrays', () => {
    const out = sanitizeFunctionResponseResult({
      $schema: 1,
      'a/b': 3,
      'c#d': 4,
      ok: [{ $ref: 5 }],
      plain: 'v',
    });
    const keys = Object.keys(out);
    expect(keys.every((k) => !/^[$#/]/.test(k) && !k.includes('/') && !k.includes('#'))).toBe(true);
    expect(out.plain).toBe('v');
    expect(Object.keys(out.ok[0])[0]).not.toContain('$');
  });

  it('returns primitives untouched', () => {
    expect(sanitizeFunctionResponseResult('x')).toBe('x');
    expect(sanitizeFunctionResponseResult(null)).toBeNull();
  });

  it('tryParseJSON parses and sanitizes; returns null-ish on invalid JSON', () => {
    expect(tryParseJSON('{"$bad": 1, "ok": 2}')).toEqual(expect.objectContaining({ ok: 2 }));
    expect(tryParseJSON('not json')).toBeFalsy();
  });
});

describe('id generators', () => {
  it('generateRequestId is agent-prefixed and unique', () => {
    const a = generateRequestId();
    expect(a).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(generateRequestId()).not.toBe(a);
  });

  it('generateSessionId is a UUID followed by a timestamp', () => {
    expect(generateSessionId()).toMatch(/^[0-9a-f-]{36}\d{10,}$/);
  });

  it('generateProjectId is adjective-noun-hex5', () => {
    expect(generateProjectId()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{5}$/);
  });
});

describe('cleanJSONSchemaForAntigravity — remaining phases', () => {
  it('passes through non-object input', () => {
    expect(cleanJSONSchemaForAntigravity(null)).toBeNull();
    expect(cleanJSONSchemaForAntigravity('str')).toBe('str');
  });

  it('converts const to enum with string values and inferred type', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: { mode: { const: 5 } },
    });
    expect(out.properties.mode).toEqual({ enum: ['5'], type: 'string' });
  });

  it('keeps an explicit type when stringifying enum values', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: { n: { type: 'integer', enum: [1, 2] } },
    });
    expect(out.properties.n.enum).toEqual(['1', '2']);
    expect(out.properties.n.type).toBe('integer');
  });

  it('merges allOf properties and required lists without duplicates', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: {
        cfg: {
          allOf: [
            { properties: { a: { type: 'string' } }, required: ['a'] },
            { properties: { b: { type: 'number' } }, required: ['a', 'b'] },
          ],
        },
      },
    });
    const cfg = out.properties.cfg;
    expect(cfg.allOf).toBeUndefined();
    expect(Object.keys(cfg.properties).sort()).toEqual(['a', 'b']);
    expect(cfg.required).toEqual(['a', 'b']);
  });

  it('flattens anyOf to the best non-null branch, preferring object > array > scalar', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: {
        v: {
          anyOf: [
            { type: 'null' },
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
            { type: 'object', properties: { x: { type: 'string' } } },
          ],
        },
      },
    });
    expect(out.properties.v.anyOf).toBeUndefined();
    expect(out.properties.v.type).toBe('object');
    expect(out.properties.v.properties.x).toBeDefined();
  });

  it('flattens oneOf the same way', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: {
        v: { oneOf: [{ type: 'null' }, { type: 'array', items: { type: 'number' } }] },
      },
    });
    expect(out.properties.v.oneOf).toBeUndefined();
    expect(out.properties.v.type).toBe('array');
  });

  it('collapses a type array to its first non-null entry, or string when all null', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: {
        a: { type: ['null', 'number'] },
        b: { type: ['null'] },
      },
    });
    expect(out.properties.a.type).toBe('number');
    expect(out.properties.b.type).toBe('string');
  });

  it('infers type:object when properties exist without a type', () => {
    const out = cleanJSONSchemaForAntigravity({
      properties: { x: { type: 'string' } },
    });
    expect(out.type).toBe('object');
  });

  it('strips every unsupported keyword and x- vendor fields, but not property NAMES', () => {
    const schema = {
      type: 'object',
      title: 'gone',
      'x-vendor': true,
      properties: {
        // property literally named like a keyword must survive
        format: { type: 'string', minLength: 2, format: 'uri' },
      },
    };
    const out = cleanJSONSchemaForAntigravity(schema);
    expect(out.title).toBeUndefined();
    expect(out['x-vendor']).toBeUndefined();
    expect(out.properties.format).toBeDefined();
    expect(out.properties.format.minLength).toBeUndefined();
    expect(out.properties.format.format).toBeUndefined();
    // sanity on the contract source
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain('minLength');
  });

  it('filters required entries whose property was dropped, deleting an empty list', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: { keep: { type: 'string' }, junk: 42 },
      required: ['keep', 'junk'],
    });
    expect(out.required).toEqual(['keep']);
    // A list whose every entry was dropped is deleted (placeholder phase does
    // not re-add one while real properties remain).
    const out2 = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: { keep: { type: 'string' }, junk: 42 },
      required: ['junk'],
    });
    expect(out2.required).toBeUndefined();
  });

  it('gives an empty schema {} an object type with a reason placeholder', () => {
    const out = cleanJSONSchemaForAntigravity({});
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['reason']);
    expect(out.properties.reason.type).toBe('string');
  });

  it('gives an empty object schema nested in properties the same placeholder', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: { sub: { type: 'object' } },
    });
    expect(out.properties.sub.required).toEqual(['reason']);
  });

  it('handles array-valued schema nodes (items as tuple) without touching property names', () => {
    const out = cleanJSONSchemaForAntigravity({
      type: 'object',
      properties: {
        tup: { type: 'array', items: [{ const: 'a' }, { type: ['null', 'integer'] }] },
      },
    });
    expect(out.properties.tup.items[0].enum).toEqual(['a']);
    expect(out.properties.tup.items[1].type).toBe('integer');
  });

  it('exposes the default safety settings with every category set to OFF', () => {
    expect(DEFAULT_SAFETY_SETTINGS.length).toBeGreaterThan(0);
    for (const s of DEFAULT_SAFETY_SETTINGS) expect(s.threshold).toBe('OFF');
  });
});
