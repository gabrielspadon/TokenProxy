import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { seed } from './seed.mjs';
import { CLOCK, SCENARIOS, VERSION } from './catalog.mjs';
import { installRedesignBrowser } from './browser.mjs';

describe('redesign fixture isolation and retained arithmetic', () => {
  it('seeds repeatable canonical rows with credentialless accounts and separated costs', async () => {
    const snapshots = [];
    for (let repetition = 0; repetition < 2; repetition++) {
      const root = await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-'));
      const receipt = await seed(root, 'populated');
      const db = new DatabaseSync(join(root, 'runtime/db/data.sqlite'), { readOnly: true });
      try {
        expect(receipt.capacity.observationCount).toBe(49);
        const accounts = db.prepare('SELECT id,provider,isActive,data FROM providerConnections ORDER BY id').all();
        expect(accounts).toHaveLength(4);
        for (const account of accounts) { expect(account.isActive).toBe(0); expect(JSON.parse(account.data).apiKey).toBeUndefined(); }
        const ledger = db.prepare('SELECT id,savedUsd,saverSavedUsd,cacheSavedUsd FROM costLedger ORDER BY id').all();
        for (const row of ledger.filter(row => row.saverSavedUsd || row.cacheSavedUsd)) expect(row.saverSavedUsd + row.cacheSavedUsd).toBeCloseTo(row.savedUsd, 12);
        expect(ledger.some(row => row.savedUsd < 0)).toBe(true);
        expect(ledger.some(row => row.savedUsd !== 0 && row.saverSavedUsd === 0 && row.cacheSavedUsd === 0)).toBe(true);
        snapshots.push({ accounts, ledger, requests: db.prepare('SELECT id,timestamp,logicalRequestId,attempt FROM requestStats ORDER BY id').all() });
      } finally { db.close(); }
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  it.each(['empty', 'single'])('seeds %s with its exact population', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-'));
    await seed(root, scenario);
    const db = new DatabaseSync(join(root, 'runtime/db/data.sqlite'), { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM providerConnections').get().count).toBe(SCENARIOS[scenario].accounts); } finally { db.close(); }
  });

  it('seeds edge identities, exact budget links, expiry and partial-deletion preconditions without inventing cost evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-'));
    const receipt = await seed(root, 'edge-cases');
    const db = new DatabaseSync(join(root, 'runtime/db/data.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM providerConnections').get().count).toBe(6);
      expect(db.prepare('SELECT remaining FROM quotaWindows WHERE connectionId=?').get(receipt.edges.custom).remaining).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM costLedger WHERE id=?').get('redesign-zero-usage').count).toBe(0);
      expect(db.prepare('SELECT promptTokens,completionTokens FROM usageHistory WHERE requestId=?').get('redesign-zero-usage')).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(db.prepare('SELECT previewExpiresAt FROM sessionPinActions WHERE id=?').get(receipt.edges.expiredPreview).previewExpiresAt < CLOCK).toBe(true);
      expect(db.prepare('SELECT id FROM proxyPools ORDER BY id').all()).toHaveLength(2);
      const budgets = db.prepare('SELECT * FROM apiKeyBudgetReservations ORDER BY requestId').all();
      expect(budgets.map(row => row.state)).toEqual(['reserved', 'uncertain']);
      expect(budgets.reduce((sum, row) => sum + row.reservedCostUsd, 0)).toBe(0.002);
      expect(db.prepare('SELECT isActive FROM apiKeys WHERE id=?').get(receipt.edges.budget.keyId).isActive).toBe(0);
      const attempt = db.prepare('SELECT r.provider,c.provider AS accountProvider,r.rateSnapshotId FROM requestStats r JOIN providerConnections c ON c.id=r.connectionId WHERE r.id=?').get(receipt.edges.budget.uncertain);
      expect(attempt.provider).toBe(attempt.accountProvider);
      expect(attempt.rateSnapshotId).toBe(receipt.edges.budget.rateId);
      expect(db.prepare('SELECT COUNT(*) AS count FROM usageHistory WHERE requestId=?').get(receipt.edges.budget.uncertain).count).toBe(0);
    } finally { db.close(); }
  });

  it('attributes browser fixtures to immutable runtime receipts and registers explicit faults separately', async () => {
    const handlers = [], scripts = [];
    const page = { route: async (pattern, handler) => handlers.push({ pattern, handler }), routeWebSocket: async () => {}, addInitScript: async (script, argument) => scripts.push({ script, argument }) };
    const runtimeReceipt = { url: 'http://127.0.0.1:61234', clock: CLOCK, fixtureVersion: 'redesign-workspace-v1' };
    const receipt = await installRedesignBrowser(page, { baseUrl: runtimeReceipt.url, runtimeReceipt, fault: 'version-conflict' });
    expect(receipt.fixtureVersion).toBe('redesign-workspace-v1');
    expect(receipt.browserFixtureVersion).toBe(VERSION);
    expect(receipt.persistence).toBe(false);
    let body;
    await handlers.at(-1).handler({ request: () => ({ method: () => 'PATCH' }), fulfill: async value => { body = value; } });
    expect(body.status).toBe(409);
    expect(JSON.parse(body.body).code).toBe('draft_revision_conflict');
    expect((await installRedesignBrowser(page, { baseUrl: runtimeReceipt.url })).fixtureVersion).toBeNull();
    await expect(installRedesignBrowser(page, { baseUrl: runtimeReceipt.url, runtimeReceipt: { ...runtimeReceipt, url: 'http://127.0.0.1:60000' } })).rejects.toThrow('another preview');
    expect(scripts[0].argument.clock).toBe(CLOCK);
    const nativeDate = globalThis.Date;
    const nativePerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    let elapsed = 100;
    try {
      Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => elapsed } });
      scripts[0].script(scripts[0].argument);
      expect(Date.now()).toBe(nativeDate.parse(CLOCK));
      elapsed += 500;
      expect(Date.now()).toBe(nativeDate.parse(CLOCK) + 500);
      expect(new Date().toISOString()).toBe('2026-09-07T12:00:00.500Z');
      expect(new Date('2026-01-01').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      globalThis.Date = nativeDate;
      Object.defineProperty(globalThis, 'performance', nativePerformance);
    }
    expect(receipt.browserClock).toBe('anchored advancing synthetic');
  });

  it('seeds twelve representative accounts with local eligibility and exact retained histories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-'));
    const receipt = await seed(root, 'representative');
    const db = new DatabaseSync(join(root, 'runtime/db/data.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS total,SUM(isActive) AS enabled,COUNT(DISTINCT provider) AS providers FROM providerConnections').get()).toEqual({ total: 12, enabled: 8, providers: 6 });
      for (const account of db.prepare('SELECT data FROM providerConnections').all()) {
        const data = JSON.parse(account.data);
        for (const secret of ['apiKey', 'accessToken', 'refreshToken', 'password']) expect(data[secret]).toBeUndefined();
      }
      expect(receipt.representative.additionalRequests).toBe(48);
      expect(db.prepare("SELECT COUNT(*) AS count FROM requestStats WHERE id LIKE 'representative-request-%'").get().count).toBe(48);
      expect(db.prepare("SELECT COUNT(*) AS count FROM usageHistory u JOIN costLedger c ON c.completionId=u.completionId JOIN requestStats r ON r.id=u.requestId WHERE r.id LIKE 'representative-request-%' AND r.provider=u.provider AND r.connectionId=u.connectionId AND r.logicalRequestId=u.logicalRequestId").get().count).toBe(48);
      const confidence = db.prepare('SELECT DISTINCT confidence FROM quotaWindows').all().map(row => row.confidence);
      expect(confidence).toEqual(expect.arrayContaining(['fresh','stale','unknown']));
    } finally { db.close(); }
  });

  it('anchors dev rows to one UTC minute while preserving stable identities and relative observation ages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-'));
    const clock = '2026-09-09T18:30:00.000Z';
    const receipt = await seed(root, 'representative', { clock });
    const db = new DatabaseSync(join(root, 'runtime/db/data.sqlite'), { readOnly: true });
    try {
      expect(receipt.capturedAt).toBe(clock);
      expect(receipt.capacity.capturedAt).toBe(clock);
      expect(db.prepare('SELECT observedAt FROM quotaWindows WHERE connectionId=?').get('connection-fixture-claude-research').observedAt).toBe('2026-09-09T18:27:00.000Z');
      expect(db.prepare('SELECT timestamp FROM requestStats WHERE id=?').get('routing-fixture-attempt-1').timestamp).toBe(clock);
      expect(db.prepare('SELECT previewExpiresAt FROM sessionPinActions WHERE id=?').get(receipt.edges.expiredPreview).previewExpiresAt).toBe('2026-09-09T17:05:00.000Z');
    } finally { db.close(); }
  });

  it('models lost activation response after a local handler and streaming interruption without dispatch', async () => {
    const handlers = [], scripts = [];
    const page = { route: async (pattern, handler) => handlers.push({ pattern, handler }), routeWebSocket: async () => {}, addInitScript: async (script, argument) => scripts.push({ script, argument }) };
    const receipt = await installRedesignBrowser(page, { baseUrl: 'http://127.0.0.1:61234', fault: 'interrupted-activation' });
    const events = [];
    await handlers.at(-1).handler({ request: () => ({ method: () => 'POST' }), fetch: async () => { events.push('local-handler'); return { status: () => 207 }; }, abort: async () => events.push('lost-response') });
    expect(events).toEqual(['local-handler', 'lost-response']);
    expect(receipt.faults[0].gatewayStatus).toBe(207);
    await installRedesignBrowser(page, { baseUrl: 'http://127.0.0.1:61234', fault: 'stream-interruption' });
    const oldFetch = globalThis.fetch, oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    let nativeCalls = 0;
    globalThis.fetch = async () => { nativeCalls++; throw new Error('Native fetch must not be reached'); };
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://127.0.0.1:61234' } });
    try {
      scripts.at(-1).script();
      const response = await globalThis.fetch('/v1/chat/completions', { method: 'POST' });
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('Synthetic interrupted event');
      await expect(reader.read()).rejects.toThrow('Synthetic browser stream interruption');
      reader.releaseLock();
      expect(nativeCalls).toBe(0);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
    }
  });

  it('blocks fetch, sockets, DNS and subprocesses while fixing the synthetic clock', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'tokenproxy-redesign-test-')));
    await mkdir(join(root, 'runtime'));
    await writeFile(join(root, 'owner.json'), JSON.stringify({ kind: 'tokenproxy-redesign-preview-v1', root, runId: 'test', realHome: homedir() }));
    await writeFile(join(root, 'fixture-manifest.json'), JSON.stringify({ accounts: [{ id: 'fixture-account', provider: 'xai' }] }));
    await writeFile(join(root, 'preview-auth.json'), JSON.stringify({ syntheticOnly: 'redesign-fixture', capturedAt: CLOCK, jwtSecret: 'synthetic-test', initialPassword: 'synthetic-test', peerToken: 'synthetic-test', dbEncryptionKey: 'synthetic-test' }));
    const code = `const assert=require('node:assert/strict');
      assert.equal(new Date().toISOString(), ${JSON.stringify(CLOCK)});
      assert.throws(()=>require('node:net').connect(443,'example.com'), {code:'EPREVIEWISOLATED'});
      assert.throws(()=>require('node:dns').lookup('example.com'), {code:'EPREVIEWISOLATED'});
      const udp=require('node:dgram').createSocket('udp4');
      assert.throws(()=>udp.send('synthetic',53,'example.com'), {code:'EPREVIEWISOLATED'}); udp.close();
      assert.throws(()=>require('node:child_process').spawn('true'), {code:'EPREVIEWISOLATED'});
      assert.equal(process.env.LEAK_TEST_API_KEY, undefined);
      assert.equal(process.env.TOKENPROXY_NO_UPDATE, '1');
      assert.throws(()=>require('node:fs').statSync(${JSON.stringify(join(homedir(),'.ssh'))}),{code:'ENOENT'});
      const headers={}; let status=0; let delivered=0;
      const server=require('node:http').createServer(()=>{delivered++;});
      const response={setHeader:(key,value)=>{headers[key]=value;},writeHead:value=>{status=value;},end:()=>{}};
      server.emit('request',{url:'/dashboard',method:'GET',headers:{}},response);
      assert.equal(headers['x-tokenproxy-preview'],'historical-snapshot');
      assert.equal(headers['x-tokenproxy-preview-kind'],'synthetic-fixture');
      assert.equal(headers['x-tokenproxy-preview-captured-at'],${JSON.stringify(CLOCK)});
      for(const url of ['/v1/responses','/api/v1/chat/completions','/codex/responses','/responses','/v1beta/models']) {
        server.emit('request',{url,method:'POST',headers:{}},response); assert.equal(status,403);
      }
      assert.equal(delivered,1);
      for (const [method,url] of [['POST','/api/admin/notification-actions'],['POST','/api/admin/configuration-domains/drafts'],['PATCH','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001'],['POST','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001/validate'],['POST','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001/activate'],['POST','/api/admin/configuration-domains/versions/1/restore'],['POST','/api/admin/configuration-domains/versions/12/rollback']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before+1,url);
      }
      for (const [method,url] of [['PUT','/api/admin/notification-actions'],['POST','/api/admin/notification-actions/dispatch'],['PATCH','/api/admin/configuration-domains/drafts'],['POST','/api/admin/configuration-domains/drafts/no-id'],['POST','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001'],['PATCH','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001/activate'],['POST','/api/admin/configuration-domains/drafts/00000000-0000-4000-8000-000000000001/activate/dispatch'],['PUT','/api/admin/configuration-domains/versions/1/restore'],['POST','/api/admin/configuration-domains/versions/0/restore'],['POST','/api/admin/configuration-domains/versions/1/rollback/all']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before,url); assert.equal(status,403,url);
      }
      for (const [method,url] of [['POST','/api/admin/projects'],['PATCH','/api/admin/projects/00000000-0000-4000-8000-000000000001'],['POST','/api/admin/projects/00000000-0000-4000-8000-000000000001/bindings'],['DELETE','/api/admin/projects/00000000-0000-4000-8000-000000000001/bindings/00000000-0000-4000-8000-000000000002']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before+1,url);
      }
      for (const [method,url] of [['POST','/api/admin/projects/test'],['POST','/api/admin/projects/00000000-0000-4000-8000-000000000001/inference'],['DELETE','/api/admin/projects/00000000-0000-4000-8000-000000000001']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before,url); assert.equal(status,403,url);
      }
      for(const [method,url] of [['POST','/api/v1/context/events'],['POST','/api/admin/routing-simulator/simulate'],['POST','/api/admin/routing-simulator/validate'],['POST','/api/admin/routing-simulator/capture'],['PUT','/api/system/admission'],['POST','/api/admin/quota/scenario'],['POST','/api/model-context'],['POST','/api/admin/auto-routing'],['PATCH','/api/context/sessions/10']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before+1,url);
      }
      for(const [method,url] of [['POST','/api/admin/shaping/evaluation-sets'],['POST','/api/admin/shaping/handoffs'],['POST','/api/admin/shaping/revoke-handoff'],['POST','/api/admin/shaping/controls'],['POST','/api/admin/shaping/plans'],['GET','/api/admin/shaping/plan-receipts?page=1&pageSize=20'],['GET','/api/admin/shaping/plan-receipts/fixture'],['PATCH','/api/pricing'],['DELETE','/api/pricing'],['POST','/api/admin/budgets'],['POST','/api/providers/custom'],['DELETE','/api/proxy-pools'],['PATCH','/api/settings'],['PUT','/api/providers/fixture-account']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before+1,url);
      }
      for(const [method,url] of [['DELETE','/api/admin/shaping/handoffs'],['POST','/api/admin/shaping/handoffs/dispatch'],['DELETE','/api/admin/shaping/evaluation-sets'],['POST','/api/admin/shaping/evaluation-sets/inference'],['POST','/api/admin/shaping/revoke-handoff/all'],['PUT','/api/v1/context/events'],['POST','/api/v1/context/events/replay'],['POST','/api/admin/routing-simulator/simulate/dispatch'],['PUT','/api/admin/routing-simulator/simulate'],['POST','/api/admin/routing-simulator/validate/dispatch'],['DELETE','/api/admin/routing-simulator/validate'],['POST','/api/admin/routing-simulator/capture/dispatch'],['DELETE','/api/admin/routing-simulator/capture'],['POST','/api/system/admission'],['PUT','/api/system/admission/live'],['PUT','/api/admin/quota/scenario'],['POST','/api/admin/quota/scenario/dispatch'],['POST','/api/admin/quota/refresh'],['PUT','/api/providers/not-fixture'],['POST','/api/providers'],['POST','/api/providers/import'],['POST','/api/translator/translate'],['POST','/api/tunnel/enable'],['POST','/api/tunnel/tailscale-enable'],['POST','/api/providers/test'],['POST','/api/models/discover'],['POST','/api/oauth/codex'],['DELETE','/api/admin/shaping/plans']]) {
        const before=delivered; server.emit('request',{url,method,headers:{}},response); assert.equal(delivered,before,url); assert.equal(status,403,url);
      }
      (async()=>{
        const json=(url,body)=>new Request('http://127.0.0.1'+url,{method:'PATCH',body:JSON.stringify(body)}).json();
        for(const body of [{codexAutoPing:{connections:{fixture:true}}},{kimiAutoPing:{connections:{fixture:false}}},{freeModelSync:{enabled:true}},{cloudEnabled:true}]) await assert.rejects(json('/api/settings',body),{code:'EPREVIEWISOLATED'});
        for(const body of [{apiKey:'synthetic'},{providerSpecificData:{refresh_token:'synthetic'}},{headers:{Authorization:'Bearer synthetic'}}]) await assert.rejects(json('/api/providers/fixture-account',body),{code:'EPREVIEWISOLATED'});
        assert.deepEqual(await json('/api/settings',{connectTimeoutMs:8000,disabledProviders:['synthetic']}),{connectTimeoutMs:8000,disabledProviders:['synthetic']});
        assert.deepEqual(await json('/api/providers/fixture-account',{name:'Synthetic account',defaultModel:'synthetic/model'}),{name:'Synthetic account',defaultModel:'synthetic/model'});
        await assert.rejects(fetch('https://example.com'),{code:'EPREVIEWISOLATED'});
        await new Promise((resolve,reject)=>require('node:fs').lstat(${JSON.stringify(join(homedir(),'.ssh'))},error=>{try{assert.equal(error.code,'ENOENT');resolve();}catch(failure){reject(failure);}}));
        require('node:fs').mkdirSync(${JSON.stringify(join(root,'runtime/db'))});
        require('node:fs').writeFileSync(${JSON.stringify(join(root,'runtime/db/data.sqlite'))},'must never be opened by a worker preload');
        const workerCode=${JSON.stringify(`require(${JSON.stringify(fileURLToPath(new URL('./guard.cjs', import.meta.url)))});require('node:assert/strict').throws(()=>require('node:net').connect(443,'example.com'),{code:'EPREVIEWISOLATED'});require('node:worker_threads').parentPort.postMessage('worker guarded without reopening SQLite');`)};
        await new Promise((resolve,reject)=>{const worker=new(require('node:worker_threads').Worker)(workerCode,{eval:true,execArgv:[]});worker.once('message',message=>{assert.equal(message,'worker guarded without reopening SQLite');});worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(new Error('worker failed')));});
        console.log('outbound guard passed');
      })().catch(error=>{console.error(error);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, ['--require', fileURLToPath(new URL('./guard.cjs', import.meta.url)), '-e', code], { encoding: 'utf8', env: { DATA_DIR: join(root, 'runtime'), TOKENPROXY_PREVIEW_ISOLATED: '1', TOKENPROXY_REDESIGN_ROOT: root, LEAK_TEST_API_KEY: 'synthetic-secret' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('outbound guard passed');
  });
});
