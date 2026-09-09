// G5 — privacy.
//
// RECONCILIATION.md P1 "Operational redaction". One canary string is planted in
// the five places a secret actually reaches this proxy — a request header, the
// client request body, the outbound provider-request body, a mid-stream SSE
// frame, and the receipt written beside them — and then every persistence path
// and every projection is asserted to be free of it.
//
// The assertion is ABSENCE OF THE VALUE, never presence of a mask. A redactor
// that stores the secret and masks it at render time passes a "contains
// [redacted]" check and still leaks: the DB row, the disk log, a backup, and any
// future reader of either see the real thing. So the DB test goes through the
// real driver and reads the row back with `getRequestDetailById`, and the disk
// test reads the bytes off the filesystem.
//
// Negative control throughout: the model, the tool names and the token counts
// survive. A log with those blanked is not a safer log, it is a useless one, and
// a redactor that gutted the record would otherwise pass every absence check
// here trivially.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  isSecretBodyKey,
  isSensitiveHeaderName,
  maskSensitiveHeaders,
  redactSecrets,
  redactSecretsText,
  stripSensitiveHeaders,
} from 'open-sse/utils/redact.js';

// Assembled from parts on purpose. A secret scanner reads the staged diff, not
// the test's intent, and cannot tell a synthetic fixture from a leaked key —
// while the redactor still receives byte-for-byte what it would see in the wild.
const CANARY = ['sk', 'canary', 'TESTSECRET1234567890abcd'].join('-');
const CANARY_JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiJmYWtlLXRlc3QtdG9rZW4ifQ',
  'ZmFrZXNpZ25hdHVyZQ',
].join('.');
const CANARY_GOOGLE = ['AIza', 'SyFAKE0000TESTONLY0000notreal'].join('');

/** The five planting sites, as one detail record. */
function plantedDetail(id) {
  return {
    id,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    connectionId: 'conn-1',
    status: 'error',
    latency: { ttft: 12, total: 340 },
    tokens: { prompt_tokens: 41, completion_tokens: 7 },
    // 1. request headers, 2. request body
    request: {
      headers: {
        authorization: `Bearer ${CANARY}`,
        'x-api-key': CANARY,
        'x-tp-peer-token': CANARY,
        'content-type': 'application/json',
      },
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: `reproduce with: curl -H "Authorization: Bearer ${CANARY}" ...` },
        { role: 'assistant', tool_calls: [{ function: { name: 'search_repo' } }] },
      ],
    },
    // 3. outbound provider request
    providerRequest: {
      model: 'gpt-5.6-sol',
      api_key: CANARY,
      credentials: { access_token: CANARY_JWT, refresh_token: CANARY },
      messages: [{ role: 'user', content: `key is ${CANARY_GOOGLE}` }],
    },
    // 4. what came back off the stream
    providerResponse: `data: {"choices":[{"delta":{"content":"echo ${CANARY}"}}]}\n\n`,
    response: {
      error: `401 from upstream: invalid key "${CANARY}" (jwt ${CANARY_JWT})`,
      status: 401,
      thinking: null,
    },
    // 5. the receipt written beside them
    pxpipe: { applied: true, imageCount: 2, note: `uploaded with ${CANARY}` },
  };
}

const everywhere = (value) => {
  const s = JSON.stringify(value);
  return { s, canaries: [CANARY, CANARY_JWT, CANARY_GOOGLE].filter((c) => s.includes(c)) };
};

describe('G5 — the redactor removes secrets and nothing else', () => {
  it('drops secret-shaped VALUES wherever they sit, including free text', () => {
    for (const canary of [CANARY, CANARY_JWT, CANARY_GOOGLE]) {
      expect(redactSecretsText(`prefix ${canary} suffix`)).not.toContain(canary);
    }
    // A bearer keeps its scheme: which auth path ran is diagnostics, the token is not.
    expect(redactSecretsText(`Authorization: Bearer ${CANARY}`)).toBe(
      'Authorization: Bearer [redacted]'
    );
  });

  it('drops secret-shaped KEYS whatever their value looks like', () => {
    // The value here is not key-shaped at all — only the field name says secret.
    const out = redactSecrets({ api_key: 'short', access_token: 'x', password: 'hunter2' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out.api_key).toBe('[redacted]');
    expect(out.access_token).toBe('[redacted]');
  });

  it('keeps the accounting fields, which a substring rule on "token" would blank', () => {
    // The exact reason body keys match WHOLE and header names match substring.
    const out = redactSecrets({
      model: 'gpt-5.6-sol',
      max_tokens: 4096,
      usage: { prompt_tokens: 41, completion_tokens: 7, cache_read_input_tokens: 12 },
      tools: [{ name: 'search_repo' }],
    });
    expect(out).toEqual({
      model: 'gpt-5.6-sol',
      max_tokens: 4096,
      usage: { prompt_tokens: 41, completion_tokens: 7, cache_read_input_tokens: 12 },
      tools: [{ name: 'search_repo' }],
    });
    expect(isSecretBodyKey('prompt_tokens')).toBe(false);
    expect(isSecretBodyKey('access_token')).toBe(true);
  });

  it('fails CLOSED on a body it cannot walk', () => {
    // A redaction failure must drop the field, never fall through to "log it all
    // because we could not scrub it".
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('unwalkable');
      },
    });
    expect(redactSecrets(hostile)).toEqual({ redacted: true, reason: 'redaction failed' });

    // Self-reference terminates rather than throwing or recursing forever.
    const cyclic = { model: 'gpt-5.6-sol' };
    cyclic.self = cyclic;
    expect(redactSecrets(cyclic).self).toBe('[circular]');
  });

  it('reconciles the two header lists that had already drifted apart', () => {
    // One list, two behaviours. The DB row drops the header; the disk log keeps
    // scheme + 4-char tail so an operator can tell two accounts apart.
    for (const name of [
      'authorization',
      'x-api-key',
      'Cookie',
      'x-tp-peer-token',
      'x-secret-thing',
    ]) {
      expect(isSensitiveHeaderName(name), name).toBe(true);
    }
    expect(isSensitiveHeaderName('content-type')).toBe(false);

    const headers = { authorization: `Bearer ${CANARY}`, 'content-type': 'application/json' };
    expect(stripSensitiveHeaders(headers)).toEqual({ 'content-type': 'application/json' });
    const masked = maskSensitiveHeaders(headers);
    expect(JSON.stringify(masked)).not.toContain(CANARY);
    expect(masked.authorization).toBe(`Bearer ***${CANARY.slice(-4)}`);
    expect(masked['content-type']).toBe('application/json');
  });
});

describe('G5 — the persisted DB row never holds the secret', () => {
  let tempDir;
  let db;
  let originalDataDir;

  beforeAll(async () => {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-g5-'));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    // The real driver, the real table. A mocked adapter would only prove the
    // redactor was called, not that the bytes on disk are clean.
    db = await import('@/lib/db/index.js');
    await db.initDb();
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function save(detail) {
    await db.saveRequestDetail(detail);
    await new Promise((r) => setTimeout(r, 150));
    return db.getRequestDetailById(detail.id);
  }

  it('stores none of the five planted canaries, in any field', async () => {
    const stored = await save(plantedDetail('g5-planted'));
    expect(stored).toBeTruthy();
    expect(everywhere(stored).canaries).toEqual([]);
  });

  it('still stores the metadata the row exists for', async () => {
    const stored = await save(plantedDetail('g5-useful'));
    expect(stored.model).toBe('gpt-5.6-sol');
    expect(stored.status).toBe('error');
    expect(stored.tokens).toEqual({ prompt_tokens: 41, completion_tokens: 7 });
    // The failure is still diagnosable: status and shape survive, key does not.
    expect(stored.response.status).toBe(401);
    expect(stored.response.error).toContain('401 from upstream');
    expect(stored.request.messages[1].tool_calls[0].function.name).toBe('search_repo');
  });

  it('scrubs BEFORE truncating, so the preview cannot carry what the body could not', async () => {
    // The stored order was the other one: `_preview` was a raw 200-char slice of
    // the serialized body, so a secret in the first 200 chars was persisted even
    // when the body was far too large to store.
    const detail = plantedDetail('g5-truncated');
    detail.request = {
      headers: { authorization: `Bearer ${CANARY}` },
      note: `key ${CANARY} then padding`,
      blob: 'x'.repeat(20 * 1024),
    };
    const stored = await save(detail);
    expect(stored.request._truncated).toBe(true);
    expect(JSON.stringify(stored.request)).not.toContain(CANARY);
    expect(stored.request.blob).toBe('[omitted: retention limit]');
    expect(everywhere(stored).canaries).toEqual([]);
  });

  it('keeps the secret out of every API projection built on the row', async () => {
    const stored = await save(plantedDetail('g5-projection'));

    vi.doMock('@/lib/usageDb', () => ({
      getRequestDetails: async () => ({
        details: [stored],
        pagination: {
          page: 1,
          pageSize: 20,
          totalItems: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    }));
    vi.doMock('@/lib/requestDetailsDb', () => ({ isObservabilityEnabled: async () => true }));
    const { GET, redactDetail } = await import('@/app/api/usage/request-details/route.js');

    const body = await GET(new Request('http://localhost/api/usage/request-details')).then((r) =>
      r.json()
    );
    expect(everywhere(body).canaries).toEqual([]);

    // And the projection scrubs on its own, for rows written before the
    // persistence fix landed: hand it the UNredacted shape directly.
    const legacy = redactDetail(plantedDetail('g5-legacy'));
    expect(everywhere(legacy).canaries).toEqual([]);
    // #2221's error envelope is still there, minus the key.
    expect(legacy.response.status).toBe(401);
    expect(legacy.response.error).toContain('401 from upstream');

    vi.doUnmock('@/lib/usageDb');
    vi.doUnmock('@/lib/requestDetailsDb');
  });
});

describe('G5 — the disk log never holds the secret', () => {
  let tempDir;
  let cwdBefore;
  let logger;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenproxy-g5-logs-'));
    cwdBefore = process.cwd();
    process.chdir(tempDir);
    // Body capture opted IN. Proving redaction with logging off proves nothing.
    process.env.ENABLE_REQUEST_LOGS = 'true';
    vi.resetModules();
    const { createRequestLogger } = await import('open-sse/utils/requestLogger.js');
    logger = await createRequestLogger('openai', 'openai', 'gpt-5.6-sol');
  });

  afterAll(() => {
    if (cwdBefore) process.chdir(cwdBefore);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ENABLE_REQUEST_LOGS;
  });

  /** Everything the session wrote, as one string — files, not parsed objects. */
  function sessionBytes() {
    const root = path.join(tempDir, 'logs', 'requests-v2');
    let out = '';
    for (const session of fs.readdirSync(root)) {
      const dir = path.join(root, session);
      for (const file of fs.readdirSync(dir)) out += fs.readFileSync(path.join(dir, file), 'utf8');
    }
    return out;
  }

  it('writes no canary to disk from any stage, header, body or stream frame', async () => {
    const planted = plantedDetail('g5-disk');

    logger.logClientRawRequest('/v1/chat/completions', planted.request, planted.request.headers);
    logger.logRawRequest(planted.request, planted.request.headers);
    logger.logOpenAIRequest(planted.request);
    logger.logTargetRequest(
      'https://api.example.test/v1/chat/completions',
      planted.request.headers,
      planted.providerRequest
    );
    logger.logProviderResponse(
      401,
      'Unauthorized',
      { 'set-cookie': `s=${CANARY}` },
      planted.response
    );
    logger.appendProviderChunk(planted.providerResponse);
    logger.appendOpenAIChunk(`data: {"delta":"${CANARY}"}\n\n`);
    logger.logConvertedResponse(planted.response);
    logger.appendConvertedChunk(`data: {"delta":"${CANARY_JWT}"}\n\n`);
    logger.logError(new Error(`upstream refused ${CANARY}`), planted.request);

    await logger.close();
    const bytes = sessionBytes();
    for (const canary of [CANARY, CANARY_JWT, CANARY_GOOGLE]) {
      expect(bytes.includes(canary), canary.slice(0, 12)).toBe(false);
    }
    // Negative control on the same bytes: the log is still a log.
    expect(bytes).toContain('gpt-5.6-sol');
    expect(bytes).toContain('search_repo');
    expect(bytes).toContain('Bearer ***');
  });
});
