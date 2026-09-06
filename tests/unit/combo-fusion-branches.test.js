// Branch coverage for open-sse/services/combo.js paths the existing suites miss:
// audio/video/pdf capability detection shapes, retry-after HTTP-date parsing via
// the 503 retry loop, accepted-stream terminality, all-members-cooling
// unavailable response, extractPanelText shapes, cycle detection, and the fusion
// panel error/timeout/empty logging paths. All upstream traffic is mocked at
// handleSingleModel; nothing leaves the process.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  detectRequiredCapabilities,
  reorderByCapabilities,
  reorderByContextFit,
  getRotatedModels,
  peekRotatedModels,
  resetComboRotation,
  resolveComboTokenSaver,
  resolveComboMemberConnection,
  findComboCycle,
  validateComboAcyclic,
  getComboModelsFromData,
  handleComboChat,
  extractPanelText,
  handleFusionChat,
} = await import('../../open-sse/services/combo.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  resetComboRotation();
  vi.clearAllMocks();
});

describe('detectRequiredCapabilities modality shapes', () => {
  it('input_audio block, message-level audio_url, and data:audio string -> audioInput', () => {
    for (const body of [
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }],
          },
        ],
      },
      { messages: [{ role: 'user', content: 'q', audio_url: 'https://a/b.mp3' }] },
      { messages: [{ role: 'user', content: 'listen: data:audio/wav;base64,AAAA' }] },
    ]) {
      expect(detectRequiredCapabilities(body).has('audioInput')).toBe(true);
    }
  });

  it('video block and document with video media_type -> videoInput', () => {
    const block = detectRequiredCapabilities({
      messages: [{ role: 'user', content: [{ type: 'video', video_url: { url: 'x' } }] }],
    });
    expect(block.has('videoInput')).toBe(true);

    const mime = detectRequiredCapabilities({
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { media_type: 'video/mp4', data: 'x' } }],
        },
      ],
    });
    expect(mime.has('videoInput')).toBe(true);
  });

  it('document with data-URI source, string pdf, and generic file fallback -> pdf', () => {
    const dataUri = detectRequiredCapabilities({
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { data: 'data:application/pdf;base64,AAAA' } }],
        },
      ],
    });
    expect(dataUri.has('pdf')).toBe(true);

    const str = detectRequiredCapabilities({
      messages: [{ role: 'user', content: 'see data:application/pdf;base64,AAAA' }],
    });
    expect(str.has('pdf')).toBe(true);

    const generic = detectRequiredCapabilities({
      messages: [{ role: 'user', content: [{ type: 'file', file: {} }] }],
    });
    expect(generic.has('pdf')).toBe(true);
  });

  it('attachments: mime-typed audio, and bare url fallback -> vision', () => {
    const audio = detectRequiredCapabilities({
      messages: [
        { role: 'user', content: 'q', attachments: [{ contentType: 'audio/mpeg', url: 'x' }] },
      ],
    });
    expect(audio.has('audioInput')).toBe(true);

    const bare = detectRequiredCapabilities({
      messages: [{ role: 'user', content: 'q', attachments: [{ url: 'https://x/img' }, null] }],
    });
    expect(bare.has('vision')).toBe(true);
  });
});

describe('reorder helpers', () => {
  it('reorderByCapabilities soft-cap tier splits satisfied hard caps by soft caps', () => {
    // Soft requirement only (nothing in HARD_CAPS): hard passes vacuously and the
    // tier is decided by the soft check, which unknown models fail.
    const models = ['unknownA/one', 'unknownB/two'];
    const out = reorderByCapabilities(models, new Set(['search']));
    expect(out).toStrictEqual(models); // both tier 1, stable order preserved
  });

  it('reorderByContextFit guards: no tokens, non-array, single model', () => {
    const one = ['a/b'];
    expect(reorderByContextFit(one, 100)).toBe(one);
    expect(reorderByContextFit(null, 100)).toBe(null);
    const two = ['a/b', 'c/d'];
    expect(reorderByContextFit(two, 0)).toBe(two);
  });
});

describe('rotation', () => {
  it('round-robin advances, peek does not, other strategies pass through', () => {
    const models = ['a/x', 'b/y', 'c/z'];
    expect(getRotatedModels(models, 'c1', 'round-robin')).toEqual(models);
    expect(peekRotatedModels(models, 'c1', 'round-robin')).toEqual(['b/y', 'c/z', 'a/x']);
    expect(getRotatedModels(models, 'c1', 'round-robin')).toEqual(['b/y', 'c/z', 'a/x']);
    expect(getRotatedModels(models, 'c1', 'fallback')).toBe(models);
    expect(peekRotatedModels(models, 'c1', 'fallback')).toBe(models);
  });
});

describe('combo token-saver and member-connection resolution', () => {
  it('resolveComboTokenSaver: outermost boolean-false gate, per-key override, guards', () => {
    const settings = {
      rtkEnabled: true,
      headroomEnabled: false,
      comboStrategies: {
        off: { tokenSaver: false },
        tuned: { tokenSaver: { headroom: true, rtk: false } },
        arr: [1, 2],
        bare: 'nope',
      },
    };
    const off = resolveComboTokenSaver(['off'], settings);
    expect(off.rtkEnabled).toBe(false);
    expect(off.headroomEnabled).toBe(false);

    const tuned = resolveComboTokenSaver('tuned', settings);
    expect(tuned.rtkEnabled).toBe(false);
    expect(tuned.headroomEnabled).toBe(true);

    // Non-string names, inherited keys, and malformed entries never read as overrides
    const untouched = resolveComboTokenSaver(
      [42, 'constructor', 'arr', 'bare', 'missing'],
      settings
    );
    expect(untouched.rtkEnabled).toBe(true);
    expect(resolveComboTokenSaver(null, settings).rtkEnabled).toBe(true);
  });

  it('resolveComboMemberConnection: pin found, guards reject non-strings and inherited keys', () => {
    const settings = {
      comboStrategies: {
        duo: { memberConnections: { 'provA/m1': 'conn-7', 'provB/m2': '' } },
        broken: { memberConnections: [1] },
      },
    };
    expect(resolveComboMemberConnection(['duo'], 'provA/m1', settings)).toBe('conn-7');
    expect(resolveComboMemberConnection(['duo'], 'provB/m2', settings)).toBeNull();
    expect(resolveComboMemberConnection(['broken', 'duo'], 'provA/m1', settings)).toBe('conn-7');
    expect(resolveComboMemberConnection(['duo'], '', settings)).toBeNull();
    expect(resolveComboMemberConnection(['constructor'], 'provA/m1', settings)).toBeNull();
    expect(resolveComboMemberConnection('duo', 'provX/none', settings)).toBeNull();
  });
});

describe('combo graph helpers', () => {
  const combos = [
    { name: 'a', models: ['b'] },
    { name: 'b', models: ['a'] },
    { name: 'root', models: ['left', 'right'] },
    { name: 'left', models: ['shared'] },
    { name: 'right', models: ['shared'] },
    { name: 'shared', models: ['prov/leaf'] },
  ];

  it('findComboCycle detects a mutual cycle and clears a diamond via the visited set', () => {
    const cycle = findComboCycle(combos, 'a');
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
    expect(findComboCycle(combos, 'root')).toBeNull(); // shared visited twice, no cycle
    expect(findComboCycle(combos, 'missing')).toBeNull();
    // no startName: scans every combo name and still finds the a<->b cycle
    expect(findComboCycle({ combos })).not.toBeNull();
    expect(findComboCycle([{ name: 'solo', models: ['p/m'] }])).toBeNull();
  });

  it('validateComboAcyclic requires a name and reports the cycle path', () => {
    expect(validateComboAcyclic({}).valid).toBe(false);
    expect(validateComboAcyclic({}).error).toMatch(/name/i);

    const bad = validateComboAcyclic({ name: 'a', models: ['b'], combosData: combos });
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain('->');

    const good = validateComboAcyclic({ name: 'solo', models: ['p/m'], combosData: [] });
    expect(good).toEqual({ valid: true, error: null });
  });

  it('getComboModelsFromData resolves full name, basename, and rejects non-strings', () => {
    expect(getComboModelsFromData('shared', combos)).toEqual(['prov/leaf']);
    expect(getComboModelsFromData('anyprovider/shared', combos)).toEqual(['prov/leaf']);
    expect(getComboModelsFromData(42, combos)).toBeNull();
    expect(getComboModelsFromData('missing', combos)).toBeNull();
  });
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

describe('handleComboChat', () => {
  const models = ['provA/m1', 'provB/m2'];

  it('retries an explicitly rejected 503 after its HTTP-date delay on the same member', async () => {
    const httpDate = new Date(Date.now() + 1000).toUTCString();
    let calls = 0;
    const handleSingleModel = vi.fn(async () => {
      calls++;
      if (calls === 1)
        return new Response('overloaded', { status: 503, headers: { 'retry-after': httpDate, 'x-tokenproxy-replay-safe': 'true' } });
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const res = await handleComboChat({
      body: null,
      models,
      handleSingleModel,
      log,
      comboName: 'duo',
    });
    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // both attempts went to the first member
    expect(handleSingleModel.mock.calls.every(([, m]) => m === 'provA/m1')).toBe(true);
    expect(res.headers.get('x-tokenproxy-combo')).toBe('true');
    expect(res.headers.get('x-tokenproxy-model')).toBe('provA/m1');
  }, 15000);

  it('499 client abort is returned as-is without trying further members', async () => {
    const handleSingleModel = vi.fn(async () => new Response('x', { status: 499 }));
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel,
      log,
      comboName: 'duo',
    });
    expect(res.status).toBe(499);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.headers.get('x-tokenproxy-combo')).toBeNull(); // preserved exactly
  });

  it('an accepted stream carrying an upstream error returns its error without rotating', async () => {
    const errFrame =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: '[qoder error 429: rate limited]' } }] }) +
      '\n\n';
    const okFrame =
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'fine' } }] }) + '\n\n';
    const handleSingleModel = vi.fn(async (body, modelStr) =>
      modelStr === 'provA/m1' ? sseResponse(errFrame) : sseResponse(okFrame)
    );
    const res = await handleComboChat({
      body: { stream: true },
      models,
      handleSingleModel,
      log,
      comboName: 'duo',
    });
    expect(res.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.headers.get('x-tokenproxy-model')).toBe('provA/m1');
    expect(res.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    expect(await res.text()).toContain('rate limited');
  });

  it('an accepted empty stream is terminal before any later member is attempted', async () => {
    const retryIso = new Date(Date.now() + 60000).toISOString();
    const later = new Date(Date.now() + 120000).toISOString();
    let call = 0;
    const handleSingleModel = vi.fn(async () => {
      call++;
      if (call === 1) return sseResponse(': keepalive\n\n');
      // both remaining failures carry retryAfter; the earlier one must win
      return jsonResponse(
        { error: { message: 'cooling down' }, retryAfter: call === 2 ? later : retryIso },
        429
      );
    });
    const res = await handleComboChat({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      models: ['provA/m1', 'provB/m2', 'provC/m3'],
      handleSingleModel,
      log,
      comboName: 'trio',
    });
    expect(res.status).toBe(502);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(res.headers.get('x-tokenproxy-combo')).toBe('true');
    expect(res.headers.get('x-tokenproxy-model')).toBe('provA/m1');
    expect(res.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    const body = await res.json();
    expect(body.error.message).toContain('no usable content');
  });

  it('a rejected structured error permits fallback, but a thrown next member stops further replay', async () => {
    let call = 0;
    const handleSingleModel = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse({ error: { code: 42, reason: 'objecty' } }, 500, { 'x-tokenproxy-replay-safe': 'true' });
      throw new Error('member exploded');
    });
    const res = await handleComboChat({
      body: {},
      models: [...models, 'provC/m3'],
      handleSingleModel,
      log,
      comboName: 'duo',
    });
    expect(res.status).toBe(502);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(res.headers.get('x-tokenproxy-replay-safe')).toBe('false');
    const body = await res.json();
    expect(body.error.message).toBe('member exploded');
  });

  it('reports the earliest reset when all members explicitly reject for quota depletion', async () => {
    const earliest = new Date(Date.now() + 60000).toISOString();
    const later = new Date(Date.now() + 120000).toISOString();
    const handleSingleModel = vi.fn(async (_body, model) => jsonResponse({
      error: { message: 'quota exhausted' }, retryAfter: model === 'provA/m1' ? later : earliest,
    }, 429, { 'x-tokenproxy-replay-safe': 'true' }));
    const response = await handleComboChat({ body: {}, models, handleSingleModel, log, comboName: 'depleted' });
    expect(response.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(response.headers.get('x-tokenproxy-model')).toBeNull();
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(59);
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect((await response.json()).error.message).toContain('quota exhausted');
  });

  it('round-robin fallback success advances the rotation cursor past the served member', async () => {
    const handleSingleModel = vi.fn(async (body, modelStr) =>
      modelStr === 'provA/m1'
        ? jsonResponse({ error: { message: 'context_length exceeded' } }, 400, { 'x-tokenproxy-replay-safe': 'true' })
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] })
    );
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel,
      log,
      comboName: 'rr',
      comboStrategy: 'round-robin',
    });
    expect(res.status).toBe(200);
    // served index 1 -> cursor moved to index 0 again (wraps past the served member)
    expect(peekRotatedModels(models, 'rr', 'round-robin')).toEqual(models);
  });
});

describe('extractPanelText', () => {
  it('openai chat, text-completion, gemini parts, and responses output shapes', () => {
    expect(extractPanelText({ choices: [{ message: { content: 'a' } }] })).toBe('a');
    expect(extractPanelText({ choices: [{ text: 'b' }] })).toBe('b');
    expect(
      extractPanelText({
        candidates: [{ content: { parts: [{ text: 'c1' }, { text: 'c2' }, null] } }],
      })
    ).toBe('c1c2');
    expect(
      extractPanelText({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'd' }] },
          { type: 'reasoning' },
        ],
      })
    ).toBe('d');
    expect(extractPanelText(null)).toBe('');
    expect(extractPanelText({ choices: [{}] })).toBe('');
    expect(extractPanelText({ candidates: [{ content: { parts: [] } }] })).toBe('');
    expect(extractPanelText({ output: [] })).toBe('');
  });
});

describe('handleFusionChat', () => {
  it('empty panel returns 400; single-member panel answers directly', async () => {
    const empty = await handleFusionChat({ body: {}, models: [], handleSingleModel: vi.fn(), log });
    expect(empty.status).toBe(400);

    const direct = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'solo' } }] }));
    const res = await handleFusionChat({
      body: {},
      models: ['p/only'],
      handleSingleModel: direct,
      log,
    });
    expect(res.status).toBe(200);
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it('logs timeout, throw, failure, empty and unparseable panel members; single survivor answers directly', async () => {
    const hang = new Promise(() => {});
    const handleSingleModel = vi.fn((body, modelStr) => {
      switch (modelStr) {
        case 'p/hang':
          return hang;
        case 'p/throw':
          return Promise.reject(new Error('panel boom'));
        case 'p/fail':
          return Promise.resolve(new Response('err', { status: 500 }));
        case 'p/empty':
          return Promise.resolve(jsonResponse({ choices: [{ message: { content: '' } }] }));
        case 'p/garbled':
          return Promise.resolve(
            new Response('not-json', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          );
        default:
          return Promise.resolve(
            jsonResponse({ choices: [{ message: { content: 'the answer' } }] })
          );
      }
    });
    const res = await handleFusionChat({
      body: { messages: [{ role: 'user', content: 'q' }] },
      models: ['p/hang', 'p/throw', 'p/fail', 'p/empty', 'p/garbled', 'p/ok'],
      handleSingleModel,
      log,
      comboName: 'panel',
      tuning: { panelHardTimeoutMs: 300, stragglerGraceMs: 20, minPanel: 2 },
    });
    expect(res.status).toBe(200);
    // survivor answered directly: p/ok called twice (panel + direct answer)
    const okCalls = handleSingleModel.mock.calls.filter(([, m]) => m === 'p/ok');
    expect(okCalls.length).toBe(2);
  });

  it('two answers reach the judge; a bodyless request gets a synthesized user turn', async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      seen.push({ body, modelStr });
      return jsonResponse({ choices: [{ message: { content: `ans-${modelStr}` } }] });
    });
    const res = await handleFusionChat({
      body: { note: 'no message arrays here' },
      models: ['p/a', 'p/b'],
      handleSingleModel,
      log,
      comboName: 'panel',
      judgeModel: ' p/judge ',
    });
    expect(res.status).toBe(200);
    const judgeCall = seen.find((c) => c.modelStr === 'p/judge');
    expect(judgeCall).toBeTruthy();
    // appendUserTurn else-branch: judge body grew a messages array from nothing
    expect(Array.isArray(judgeCall.body.messages)).toBe(true);
    expect(judgeCall.body.messages[0].role).toBe('user');
    expect(judgeCall.body.messages[0].content).toContain('[Source 1]');
  });
});
