// G7 — runtime patch parity, proven natively.
//
// RECONCILIATION.md line 87: "Prove native parity for max effort, cache
// controls, cache and cost truth, tool-fragment normalization, usage-only
// termination, exact account pins, deterministic 4xx handling, provider
// metadata, generation IDs, and bundled-log removal. Do not recreate byte
// patching."
//
// The predecessor shipped these ten behaviors as a byte patch over a minified
// bundle: a build step that rewrote string literals in someone else's compiled
// output, verified only by counting regex matches. That is a specification of
// OBSERVABLE BEHAVIOR, not code to port. Every assertion below runs against an
// exported function of a readable source module, so each behavior is provable
// the way any other behavior in this repo is. Nothing here reads a source file
// or asserts on a source string, because a grep over source proves only that a
// character sequence exists, never that the behavior holds.
//
// Every fixture that looks like a secret is synthetic and obviously fake.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS } from 'open-sse/providers/index.js';
import { applyThinking } from 'open-sse/translator/concerns/thinkingUnified.js';
import { filterToOpenAIFormat } from 'open-sse/translator/formats/openai.js';
import { FORMATS } from 'open-sse/translator/formats.js';
import { translateRequest } from 'open-sse/translator/index.js';
import { mergeToolArguments } from 'open-sse/translator/concerns/toolCall.js';
import {
  openaiToClaudeResponse,
  resolveProviderCost,
} from 'open-sse/translator/response/openai-to-claude.js';
import { translateNonStreamingResponse } from 'open-sse/handlers/chatCore/nonStreamingHandler.js';
import {
  claudeToOpenAIRequest,
  PASSTHROUGH_REQUEST_FIELDS,
} from 'open-sse/translator/request/claude-to-openai.js';
import {
  checkFallbackError,
  isDeterministicClientError,
  RETRYABLE_CLIENT_ERROR_STATUSES,
} from 'open-sse/services/accountFallback.js';
import { NEVER_RETRY_STATUSES } from 'open-sse/utils/error.js';
import { OpenRouterExecutor } from 'open-sse/executors/openrouter.js';
import {
  GENERATION_ID_HEADER,
  safeGenerationId,
  withGenerationIdHeader,
} from 'open-sse/utils/generationId.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------------------------------------------------------------------------
// Handler-level mocks, needed only by G7.6's account-pin cases. Same shape as
// the sibling chat handler suites: the real module graph reaches the DB, and
// this gate is about the routing decision, not the DB.
// ---------------------------------------------------------------------------
const authMocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
const dispatchMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));
const modelMocks = vi.hoisted(() => ({ getComboModels: vi.fn(), getModelInfo: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock('@/sse/services/auth.js', () => ({
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  getProviderCredentials: authMocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: authMocks.markAccountUnavailable,
  getReachableProviders: vi.fn(async () => null),
  releaseAccountLease: vi.fn(),
  releaseAccountLeaseOnResponse: vi.fn((response) => response),
}));
vi.mock('open-sse/handlers/chatCore.js', () => dispatchMocks);
vi.mock('open-sse/services/combo.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectRequiredCapabilities: vi.fn(() => []),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
vi.mock('@/sse/services/model.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...modelMocks,
}));
vi.mock('@/lib/localDb', () => settingsMocks);
vi.mock('@/sse/services/tokenRefresh.js', () => ({
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
  updateProviderCredentials: vi.fn(),
}));
vi.mock('open-sse/utils/ollamaTransform.js', () => ({ transformToOllama: (response) => response }));

let handleChat;
let readAttemptCeiling;
let __rateLimiter;

beforeAll(async () => {
  ({ handleChat, readAttemptCeiling, __rateLimiter } = await import('@/sse/handlers/chat.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  __rateLimiter.reset();
  settingsMocks.getSettings.mockResolvedValue({
    requireApiKey: false,
    providerThinking: {},
    providerStrategies: {},
  });
  modelMocks.getComboModels.mockResolvedValue(null);
  modelMocks.getModelInfo.mockResolvedValue({ provider: 'codex', model: 'gpt-5.6-sol' });
  authMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
});

// A stream state object as the converter expects to receive it: fresh per turn.
const streamState = () => ({ toolCalls: new Map(), nextBlockIndex: 0 });

// Drive a whole chunk sequence through the Claude stream converter and return
// the flat event list, so an assertion can name the event it cares about.
function claudeEvents(chunks, state = streamState()) {
  const events = [];
  for (const chunk of chunks) {
    const out = openaiToClaudeResponse(chunk, state);
    if (Array.isArray(out)) events.push(...out);
  }
  return events;
}

describe('G7.1 max effort survives instead of being rewritten to xhigh', () => {
  const effortOf = (model, effort, provider = 'codex') =>
    applyThinking(FORMATS.OPENAI, model, { model, messages: [], reasoning_effort: effort }, provider)
      .reasoning_effort;

  it('keeps max for a model whose declared ladder contains max', () => {
    expect(effortOf('gpt-5.6-sol', 'max')).toBe('max');
  });

  it('passes low, medium, high and xhigh through untouched', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      expect(effortOf('gpt-5.6-sol', level), level).toBe(level);
    }
  });

  it('drops a level outside the ladder rather than forwarding it upstream', () => {
    // The whole point of the guard: an unknown enum member reaches the provider
    // as a 400, and on a provider that answers 400 for it the account is marked
    // unavailable for what was only a caller typo.
    for (const bogus of ['turbo', 'extreme', '9', 'maximum']) {
      expect(effortOf('gpt-5.6-sol', bogus), bogus).toBeUndefined();
    }
  });

  it('still clamps max down for a model whose ladder stops at xhigh', () => {
    // Preserving max must not mean sending it where it is not offered.
    expect(effortOf('gpt-5.3-codex', 'max')).toBe('xhigh');
  });
});

describe('G7.2 cache controls survive request normalization', () => {
  const body = () => ({
    model: 'some-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'cached prefix', cache_control: { type: 'ephemeral' } },
          { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
        ],
      },
    ],
  });

  it('keeps cache_control when the caller asks normalization to preserve it', () => {
    const out = filterToOpenAIFormat(body(), { preserveCacheControl: true });
    expect(out.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips cache_control by default, which is what most upstreams require', () => {
    const out = filterToOpenAIFormat(body(), {});
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
  });

  it('declares the quirk on the provider that honours the markers', () => {
    // OpenRouter passes the markers to an upstream that reads them. Stripping
    // them turned every cached prompt into a full-price one, and the request
    // still succeeded, so nothing surfaced the loss but the bill.
    expect(PROVIDERS.openrouter?.quirks?.preserveCacheControl).toBe(true);
  });

  it('carries the markers through the whole request translation for that provider', () => {
    // The quirk only matters if the translator reads it, which is the wiring
    // the byte patch had to recreate by hand at each call site.
    const kept = translateRequest(
      FORMATS.OPENAI, FORMATS.OPENAI, 'some-model', body(), false, null, 'openrouter',
    );
    expect(kept.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });

    const stripped = translateRequest(
      FORMATS.OPENAI, FORMATS.OPENAI, 'some-model', body(), false, null, 'openai',
    );
    expect(stripped.messages[0].content[0].cache_control).toBeUndefined();
  });
});

describe('G7.3 cache and cost truth survive every conversion', () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    cached_tokens: 80,
    cache_creation_input_tokens: 7,
    cost_details: { upstream_inference_cost: 0.0042 },
  };

  it('reads a top-level cached count that no nested details block carried', () => {
    // A gateway aggregating several upstreams reports the cache read at the top
    // of `usage` and sends no prompt_tokens_details at all.
    const state = streamState();
    openaiToClaudeResponse({ choices: [], usage }, state);
    expect(state.usage.cache_read_input_tokens).toBe(80);
    expect(state.usage.cache_creation_input_tokens).toBe(7);
    // input_tokens excludes what was served from cache: Anthropic's convention.
    expect(state.usage.input_tokens).toBe(100 - 80 - 7);
  });

  it('accepts the Anthropic spelling of the cache read as well', () => {
    const state = streamState();
    openaiToClaudeResponse(
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 1, cache_read_input_tokens: 40 } },
      state,
    );
    expect(state.usage.cache_read_input_tokens).toBe(40);
  });

  it("carries the upstream's own price, including a genuine zero", () => {
    expect(resolveProviderCost({ cost: 0.5 })).toBe(0.5);
    expect(resolveProviderCost({ cost_details: { upstream_inference_cost: 0.25 } })).toBe(0.25);
    // A free-tier route really did cost nothing; re-estimating it invents a charge.
    expect(resolveProviderCost({ cost: 0 })).toBe(0);
    expect(resolveProviderCost({})).toBeUndefined();
    expect(resolveProviderCost(null)).toBeUndefined();

    const state = streamState();
    openaiToClaudeResponse({ choices: [], usage }, state);
    expect(state.usage.cost).toBe(0.0042);
  });

  it('projects the cache split and the cost onto the Claude terminal event', () => {
    const events = claudeEvents([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
      { choices: [], usage },
    ]);
    const terminal = events.find((e) => e.type === 'message_delta');
    expect(terminal.usage).toMatchObject({
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 7,
      cost: 0.0042,
    });
  });

  it('reports the same cache and cost on the non-streaming Claude conversion', () => {
    // The same request billed differently depending only on `stream` is the bug.
    const out = translateNonStreamingResponse(
      {
        id: 'chatcmpl-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage,
      },
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
    );
    expect(out.usage).toMatchObject({
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 7,
      cost: 0.0042,
    });
  });

  it('reports the cached count on the non-streaming Responses conversion', () => {
    const out = translateNonStreamingResponse(
      {
        id: 'chatcmpl-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage,
      },
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.usage.input_tokens_details.cached_tokens).toBe(80);
  });
});

describe('G7.4 repeated tool-argument fragments normalize to one payload', () => {
  it('appends an ordinary delta', () => {
    expect(mergeToolArguments('{"a"', ':1}')).toBe('{"a":1}');
    expect(mergeToolArguments('', '{"a":1}')).toBe('{"a":1}');
    expect(mergeToolArguments(undefined, '{')).toBe('{');
  });

  it('replaces rather than appends when the fragment restates the buffer', () => {
    // Some OpenAI-compatible upstreams restate the whole accumulated string on
    // every chunk. A blind append yields {"a":1}{"a":1}, which no Anthropic
    // client can parse, and the upstream status is 200 so nothing fails over.
    expect(mergeToolArguments('{"a":', '{"a":1}')).toBe('{"a":1}');
  });

  it('collapses an exact terminal replay of a complete object', () => {
    expect(mergeToolArguments('{"a":1}', '{"a":1}')).toBe('{"a":1}');
  });

  it('leaves a doubled string alone when the halves are not valid JSON', () => {
    // The collapse is gated on the half parsing, so "abab" stays a real value.
    expect(mergeToolArguments('ab', 'ab')).toBe('abab');
  });

  it('emits one input_json_delta per tool call through the Claude converter', () => {
    const events = claudeEvents([
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":' } }] },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"/x"}' } }] },
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const deltas = events.filter((e) => e.delta?.type === 'input_json_delta');
    expect(deltas).toHaveLength(1);
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ file_path: '/x' });
  });

  it('emits each tool closure once even when finish_reason repeats', () => {
    const events = claudeEvents([
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{}' } }] },
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(events.filter((e) => e.type === 'content_block_stop')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
  });
});

describe('G7.5 a usage-only event terminates the stream', () => {
  it('reaches the converter instead of being dropped for carrying no choice', () => {
    const state = streamState();
    const out = openaiToClaudeResponse(
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      state,
    );
    expect(state.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
    expect(out).toBeNull(); // usage recorded, nothing to emit yet
  });

  it('holds the terminal back when the finish chunk promises usage is coming', () => {
    // `stream_options.include_usage` is a two-part protocol: an explicit
    // `usage: null` up to and including the finish chunk, then the real counts.
    // Closing on the finish chunk reports zeros on exactly the streams that were
    // about to report the truth.
    const state = streamState();
    const onFinish = openaiToClaudeResponse(
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
      state,
    );
    expect((onFinish || []).some((e) => e.type === 'message_stop')).toBe(false);

    const onUsage = openaiToClaudeResponse(
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
      state,
    );
    expect(onUsage.find((e) => e.type === 'message_delta').usage)
      .toMatchObject({ input_tokens: 9, output_tokens: 4 });
    expect(onUsage.at(-1).type).toBe('message_stop');
  });

  it('terminates immediately when the provider makes no such promise', () => {
    // A provider that simply omits `usage` is promising nothing, so waiting for
    // counts that never arrive would hang the client.
    const state = streamState();
    const out = openaiToClaudeResponse(
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      state,
    );
    expect(out.at(-1).type).toBe('message_stop');
  });

  it('releases a held terminal at flush so a truncated stream still closes', () => {
    // `data: [DONE]` is withheld from a Claude client, so nothing else will.
    const state = streamState();
    openaiToClaudeResponse(
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
      state,
    );
    expect(openaiToClaudeResponse(null, state).at(-1).type).toBe('message_stop');
  });
});

describe('G7.6 an exact account pin is honored or refused, never substituted', () => {
  // Synthetic, obviously fake, and never read from the environment.
  const account = (connectionId) => ({
    connectionId,
    connectionName: connectionId,
    apiKey: 'sk-fake-not-a-real-key',
    providerSpecificData: {},
  });

  const request = (headers = {}) =>
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'codex/gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

  const failure = (status, error) => ({
    success: false,
    failureMetadata: { safeToReplay: true },
    status,
    error,
    response: Response.json({ error: { message: error } }, { status }),
  });

  it('forwards the fields that identify the route and the upstream prompt cache', () => {
    expect(PASSTHROUGH_REQUEST_FIELDS).toEqual(['provider', 'session_id', 'prompt_cache_key']);
    const out = claudeToOpenAIRequest(
      'some-model',
      {
        messages: [{ role: 'user', content: 'hi' }],
        provider: { order: ['upstream-a'] },
        session_id: 'session-synthetic-1',
        prompt_cache_key: 'cache-key-synthetic-1',
      },
      true,
    );
    expect(out.provider).toEqual({ order: ['upstream-a'] });
    expect(out.session_id).toBe('session-synthetic-1');
    expect(out.prompt_cache_key).toBe('cache-key-synthetic-1');
  });

  it('invents none of those fields when the caller sent none', () => {
    const out = claudeToOpenAIRequest('some-model', { messages: [] }, false);
    for (const field of PASSTHROUGH_REQUEST_FIELDS) expect(field in out).toBe(false);
  });

  it('refuses rather than serving a substituted connection', async () => {
    // Selection may hand back a healthy account instead of the pinned one. For
    // a caller that named an account that is not a helpful fallback: it spends
    // the wrong subscription and breaks the account-bound state the pin existed
    // to reach.
    authMocks.getProviderCredentials.mockResolvedValue(account('account-b'));

    const response = await handleChat(request({ 'x-connection-id': 'account-a' }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { failure_phase: 'provider' },
    });
    expect(dispatchMocks.handleChatCore).not.toHaveBeenCalled();
  });

  it('proceeds when selection honoured the pin', async () => {
    authMocks.getProviderCredentials.mockResolvedValue(account('account-a'));
    dispatchMocks.handleChatCore.mockResolvedValue({
      success: true,
      response: Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    });

    const response = await handleChat(request({ 'x-connection-id': 'account-a' }));

    expect(response.status).toBe(200);
    expect(dispatchMocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("stops at the caller's attempt ceiling instead of spending the whole pool", async () => {
    authMocks.getProviderCredentials.mockImplementation(async (_p, excluded) =>
      account(`account-${excluded?.size ?? 0}`),
    );
    dispatchMocks.handleChatCore.mockResolvedValue(failure(502, 'upstream exploded'));

    const capped = await handleChat(request({ 'x-max-attempts': '1' }));

    expect(capped.status).toBe(502);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it('rotates past the first failure when no ceiling was given', async () => {
    // Control for the case above: the ceiling is what stopped it, not the 502.
    authMocks.getProviderCredentials.mockImplementation(async (_p, excluded) =>
      excluded?.size ? null : account('account-a'),
    );
    dispatchMocks.handleChatCore.mockResolvedValue(failure(502, 'upstream exploded'));

    await handleChat(request());

    expect(authMocks.getProviderCredentials.mock.calls.length).toBeGreaterThan(1);
  });

  it('caps the attempt budget only for a positive safe integer', () => {
    const header = (value) =>
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: value === null ? {} : { 'x-max-attempts': value },
      });
    expect(readAttemptCeiling(header('2'))).toBe(2);
    // "0" and "-1" must not read as "stop after zero attempts", which would
    // refuse every request outright.
    for (const bad of ['0', '-1', 'many', '1.5', '', '1e400']) {
      expect(readAttemptCeiling(header(bad)), bad).toBeNull();
    }
    expect(readAttemptCeiling(header(null))).toBeNull();
  });
});

describe('G7.7 a deterministic 4xx never quarantines a healthy model', () => {
  it('classifies every unmatched 4xx as deterministic, with no fallback and no cooldown', () => {
    for (const status of [405, 406, 410, 411, 414, 415, 418, 421, 451]) {
      expect(isDeterministicClientError(status), `status ${status}`).toBe(true);
      expect(checkFallbackError(status, ''), `status ${status}`)
        .toEqual({ shouldFallback: false, cooldownMs: 0 });
    }
  });

  it('exempts the statuses that describe timing rather than the request', () => {
    expect([...RETRYABLE_CLIENT_ERROR_STATUSES].sort()).toEqual([402, 408, 409, 425, 429]);
    for (const status of RETRYABLE_CLIENT_ERROR_STATUSES) {
      expect(isDeterministicClientError(status), `status ${status}`).toBe(false);
      expect(checkFallbackError(status, '').shouldFallback, `status ${status}`).toBe(true);
    }
  });

  it('leaves 5xx and a non-numeric status to the transient path', () => {
    for (const status of [500, 502, 503]) {
      expect(isDeterministicClientError(status), `status ${status}`).toBe(false);
      expect(checkFallbackError(status, ''), `status ${status}`)
        .toMatchObject({ shouldFallback: true });
    }
    for (const status of [undefined, null, NaN, 'oops', 399, 500]) {
      expect(isDeterministicClientError(status), String(status)).toBe(false);
    }
  });

  it('keeps a credential fact rotating, because that is not a caller error', () => {
    // 401 and 403 describe the KEY, so the next key is a different fact and
    // rotation is right. A bare 404 is about the model on this account.
    for (const status of [401, 403, 404]) {
      const verdict = checkFallbackError(status, '');
      expect(verdict.shouldFallback, `status ${status}`).toBe(true);
      expect(verdict.cooldownMs, `status ${status}`).toBeGreaterThan(0);
    }
  });

  it('keeps the two 4xx classifiers independent, and disagreeing only where intended', () => {
    // They answer different questions. NEVER_RETRY_STATUSES gates whether a
    // refusal may advertise Retry-After; isDeterministicClientError gates
    // provider fallback and model cooldown. 402 is the one deliberate
    // disagreement: telling THIS caller to wait is wrong (the account is out of
    // credit and waiting will not refill it), while moving to the NEXT account
    // is right, because a different account has a different balance.
    expect(NEVER_RETRY_STATUSES.has(402)).toBe(true);
    expect(isDeterministicClientError(402)).toBe(false);
    for (const status of NEVER_RETRY_STATUSES) {
      if (status === 402) continue;
      expect(isDeterministicClientError(status), `status ${status}`).toBe(true);
    }
    // And nothing the fallback path calls retryable may advertise a wait window
    // it cannot honour: every remaining member is outside the never-retry set.
    for (const status of RETRYABLE_CLIENT_ERROR_STATUSES) {
      if (status === 402) continue;
      expect(NEVER_RETRY_STATUSES.has(status), `status ${status}`).toBe(false);
    }
  });
});

describe('G7.8 provider metadata is opted into and allowlisted', () => {
  const executor = new OpenRouterExecutor();
  const base = () => ({ model: 'some-model', messages: [{ role: 'user', content: 'hi' }] });

  it('asks for authoritative usage on every request', () => {
    // Without it the gateway reports no token counts on a streamed turn and
    // this router bills against a character-count estimate.
    const out = executor.transformRequest('some-model', { ...base(), stream: false }, false, {});
    expect(out.usage).toMatchObject({ include: true });
  });

  it('asks for the trailing usage chunk only when streaming', () => {
    const streamed = executor.transformRequest('some-model', { ...base(), stream: true }, true, {});
    expect(streamed.stream_options).toMatchObject({ include_usage: true });
    const plain = executor.transformRequest('some-model', { ...base(), stream: false }, false, {});
    expect(plain.stream_options).toBeUndefined();
  });

  it('forwards the metadata header only for the exact opt-in value', () => {
    const metadataHeader = (raw) => executor.buildHeaders(
      { apiKey: 'sk-fake-not-a-real-key', rawHeaders: raw },
      true,
      'https://example.invalid/v1/chat/completions',
      'some-model',
    )['X-OpenRouter-Metadata'];

    expect(metadataHeader({ 'x-openrouter-metadata': 'enabled' })).toBe('enabled');
    // Not an allowlist a caller can widen: anything else sends nothing, because
    // metadata costs an extra upstream lookup and stays off by default.
    for (const value of ['ENABLED', 'true', '1', '', 'enabled ', undefined]) {
      expect(metadataHeader({ 'x-openrouter-metadata': value }), String(value)).toBeUndefined();
    }
    expect(metadataHeader(undefined)).toBeUndefined();
  });
});

describe('G7.9 an upstream generation id is forwarded or dropped, never repaired', () => {
  // A plain header bag rather than a Headers instance on purpose: the hostile
  // values below are exactly the ones the platform Headers constructor refuses,
  // and the guard has to survive a transport that does not refuse them.
  const response = (value) => ({ headers: { get: () => (value === undefined ? null : value) } });

  it('names one response header for both the streaming and JSON paths', () => {
    expect(GENERATION_ID_HEADER).toBe('X-Generation-Id');
  });

  it('forwards an id made only of allowlisted characters', () => {
    expect(safeGenerationId(response('gen-abc_1.2:3'))).toBe('gen-abc_1.2:3');
    expect(safeGenerationId(response('x'.repeat(200)))).toBe('x'.repeat(200));
    expect(withGenerationIdHeader({ 'Content-Type': 'application/json' }, response('gen-1')))
      .toEqual({ 'Content-Type': 'application/json', [GENERATION_ID_HEADER]: 'gen-1' });
  });

  it('drops a value carrying a header separator, which is the injection vector', () => {
    // The value arrives from a third party and is written into a header this
    // proxy emits: a CR or LF splits the response and lets the upstream inject
    // headers into a reply the client trusts. Dropped whole, never sanitized —
    // a repaired id is not the upstream's id.
    for (const hostile of ['a\nb', 'a\r\nb', 'a\rb', 'a b', 'a\tb', 'a;b', 'a,b', 'a"b']) {
      expect(safeGenerationId(response(hostile)), JSON.stringify(hostile)).toBeNull();
      expect(withGenerationIdHeader({}, response(hostile))).toEqual({});
    }
  });

  it('drops an empty or oversize id', () => {
    // The ceiling is part of the guard: an unbounded header from an upstream is
    // a cheap way to blow a client's or an intermediary's header budget.
    expect(safeGenerationId(response(''))).toBeNull();
    expect(safeGenerationId(response('x'.repeat(201)))).toBeNull();
  });

  it('adds nothing when the upstream sent no id at all', () => {
    expect(safeGenerationId(response(undefined))).toBeNull();
    expect(safeGenerationId(null)).toBeNull();
    expect(safeGenerationId({})).toBeNull();
    const headers = withGenerationIdHeader({ 'Content-Type': 'text/event-stream' }, response(undefined));
    expect(headers).toEqual({ 'Content-Type': 'text/event-stream' });
    expect(GENERATION_ID_HEADER in headers).toBe(false);
  });

  it("returns a new object rather than mutating the caller's header set", () => {
    const original = { 'Content-Type': 'application/json' };
    const merged = withGenerationIdHeader(original, response('gen-1'));
    expect(original).toEqual({ 'Content-Type': 'application/json' });
    expect(merged).not.toBe(original);
  });
});

describe('G7.10 no bundled sample logs ship in the package', () => {
  // 60s, not the 5s default: this shells out to `npm pack --dry-run` over a
  // 3429-file package tree. It measured 4.2s standalone and 8.0s inside the
  // full parallel suite, so the default made it a load-dependent flake that
  // reported as a content failure rather than as a timeout.
  it('packs no file under any logs directory', { timeout: 60_000 }, () => {
    // Asserted against the real packed file list rather than a hardcoded path:
    // a hardcoded string proves nothing about what a future `files` entry lets
    // back in. `--dry-run` writes no tarball.
    const raw = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json'],
      { cwd: join(REPO_ROOT, 'cli'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const files = JSON.parse(raw)[0].files.map((entry) => entry.path);
    expect(files.length).toBeGreaterThan(0);
    // What the removed patch deleted was app/logs/translator/*, sample request
    // and response bodies. The framework's compiled output is excluded FIRST
    // and only then is the broad rule applied, because .next-cli-build mirrors
    // route URLs on disk, so /api/usage/logs/route.js is a compiled handler and
    // matching it would make this assertion fire on a correct build. Everything
    // the package author controls still gets the broad rule, so a future `files`
    // entry that lets real sample logs back in is still caught.
    const authored = files.filter((path) => !path.includes('.next-cli-build/'));
    expect(authored.length).toBeGreaterThan(0);
    expect(authored.filter((path) => /(^|\/)logs(\/|$)/i.test(path))).toEqual([]);
    expect(files.filter((path) => /\.(log|ndjson|jsonl)$/i.test(path))).toEqual([]);
  });
});
