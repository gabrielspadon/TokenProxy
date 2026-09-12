import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';

function assertOwnedSeed(seeded) {
  const root = realpathSync(seeded.root);
  const owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8'));
  const auth = JSON.parse(readFileSync(join(root, 'preview-auth.json'), 'utf8'));
  assert.equal(root, seeded.root);
  assert.equal(owner.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(owner.runId, seeded.runId);
  assert.equal(owner.root, root);
  assert.equal(auth.syntheticOnly, 'redesign-fixture');
  assert.equal(existsSync(join(root, 'process.json')), false, 'Workflow preparation requires an unstarted fixture');
}

export function prepareShapingFixture(seeded, artifacts) {
  assertOwnedSeed(seeded);
  const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(marker.root, seeded.root);

  // The representative scenario records no client-reported identity, so
  // handoffTargets (shapingHandoffsRepo.js:96-104) returns an empty population and
  // the Handoffs controls have no eligible pair. Seed exactly the rows that query
  // joins: two active keys bound to one live project, each with one observed
  // request carrying a distinct client-reported session ref. Refs are built with
  // the same HMAC the gateway uses (contextEvidenceRepo.js:39-42) over a salt
  // written into _meta, so a live request from either identity would resolve to
  // the same ref rather than to a hand-written string.
  const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
  const salt = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('contextEvidenceSalt.v1', salt);
  const key = Buffer.from(salt, 'hex');
  const ref = (clientKeyId, clientId, field, value) =>
    `ctx1_${createHmac('sha256', key).update(JSON.stringify(['identity-v1', clientKeyId, clientId, field, value])).digest('hex')}`;
  const at = new Date(Date.parse(seeded.clock) - 60000).toISOString();
  const projectId = randomUUID();
  db.prepare('INSERT INTO projects(id,name,revision,createdAt,updatedAt,archived) VALUES(?,?,1,?,?,0)')
    .run(projectId, 'Synthetic handoff project', at, at);
  const sessions = [];
  for (const [index, client] of ['handoff-source', 'handoff-target'].entries()) {
    const keyId = `shaping-${client}-key`;
    db.prepare('INSERT INTO apiKeys(id,key,name,isActive,createdAt) VALUES(?,?,?,1,?)')
      .run(keyId, `sk-synthetic-${client}-not-a-credential`, `Synthetic ${client}`, at);
    const identity = {
      clientKeyId: keyId,
      clientIdentitySource: 'client-reported',
      clientRef: ref(keyId, client, 'clientRef', client),
      clientSessionRef: ref(keyId, client, 'clientSessionRef', `${client}-session`),
      taskRef: null,
      projectRef: ref(keyId, client, 'projectRef', 'shaping-handoff-project'),
    };
    const requestId = randomUUID();
    const fields = {
      id: requestId,
      timestamp: new Date(Date.parse(at) - index * 1000).toISOString(),
      provider: 'openai',
      model: 'gpt-4o',
      connectionId: 'connection-fixture-alpha',
      status: 'success',
      clientTool: `Synthetic ${client}`,
      requestedModel: 'openai/gpt-4o',
      dispatchCoverage: 'physical-dispatch',
      ...identity,
    };
    const names = Object.keys(fields);
    db.prepare(`INSERT INTO requestStats(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`)
      .run(...Object.values(fields));
    db.prepare('INSERT INTO projectBindings(id,projectId,apiKeyId,clientRef,projectRef,createdAt) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), projectId, keyId, identity.clientRef, identity.projectRef, at);
    sessions.push({ client, requestId, keyId });
  }
  const eligible = db
    .prepare(
      `SELECT COUNT(*) AS count FROM requestStats r
       JOIN projectBindings b ON b.apiKeyId=r.clientKeyId AND b.clientRef=r.clientRef AND b.projectRef=r.projectRef
       JOIN projects p ON p.id=b.projectId AND p.archived=0
       JOIN apiKeys k ON k.id=r.clientKeyId AND k.isActive=1
       WHERE r.clientIdentitySource='client-reported' AND r.clientSessionRef IS NOT NULL`
    )
    .get().count;
  db.close();
  assert.equal(eligible, 2, 'Two eligible handoff sessions must exist before the journey runs');

  // A small explicitly selected Claude-format set, written where the browser can
  // hand it to the real file input. Three cases stay inside every published bound
  // (64 cases, 1 MiB per body, 8 MiB per set).
  const cases = [
    {
      id: 'selected-plain',
      contextWindow: 200000,
      description: 'Two historical turns with signed reasoning plus a live turn.',
      body: {
        model: 'synthetic-claude-compatible',
        system: [{ type: 'text', text: 'Preserve evidence exactly.' }],
        max_tokens: 512,
        messages: [
          { role: 'user', content: 'Earlier request one: ' + 'alpha beta gamma '.repeat(40) },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning one.', signature: 'hist-1' }, { type: 'text', text: 'Earlier answer one.' }] },
          { role: 'user', content: 'Earlier request two: ' + 'delta epsilon zeta '.repeat(40) },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning two.', signature: 'hist-2' }, { type: 'text', text: 'Earlier answer two.' }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Live reasoning must remain.', signature: 'live-1' }, { type: 'text', text: 'Ready.' }] },
          { role: 'user', content: 'Keep identifier K-002, citation [7], number 1.00 and code `x  +=  1`.' },
        ],
      },
    },
    {
      id: 'selected-tool-transaction',
      contextWindow: 200000,
      description: 'A resolved tool transaction with unicode and whitespace payload.',
      body: {
        model: 'synthetic-claude-compatible',
        max_tokens: 512,
        tools: [{ name: 'read_file', description: 'Read exact bytes.', input_schema: { type: 'object', properties: { path: { type: 'string', enum: ['ação.txt'] } }, required: ['path'] } }],
        messages: [
          { role: 'user', content: 'Earlier request: ' + 'red green blue '.repeat(40) },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning.', signature: 'hist-3' }, { type: 'text', text: 'Earlier answer.' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call-001', name: 'read_file', input: { path: 'ação.txt' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-001', content: '{\n  "number": 1.00,\n  "text": "A  B",\n  "unicode": "ação 🌊"\n}' }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Live reasoning must remain.', signature: 'live-2' }, { type: 'text', text: 'Read.' }] },
          { role: 'user', content: 'Answer in Portuguese and keep the exact bytes.' },
        ],
      },
    },
    {
      id: 'selected-tool-error',
      contextWindow: 200000,
      description: 'An error tool result whose trace must survive every stage.',
      body: {
        model: 'synthetic-claude-compatible',
        max_tokens: 512,
        tools: [{ name: 'read_file', description: 'Read exact bytes.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
        messages: [
          { role: 'user', content: 'Earlier request: ' + 'one two three '.repeat(40) },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning.', signature: 'hist-4' }, { type: 'text', text: 'Earlier answer.' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call-002', name: 'read_file', input: { path: '/missing' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-002', is_error: true, content: 'ENOENT: /missing, code 007, retry=false' }] },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Live reasoning must remain.', signature: 'live-3' }, { type: 'text', text: 'Failed.' }] },
          { role: 'user', content: 'Report the exact error text.' },
        ],
      },
    },
  ];
  const casesFile = join(artifacts, 'selected-cases.json');
  writeFileSync(casesFile, JSON.stringify(cases, null, 2));
  writeFileSync(
    join(artifacts, 'synthetic-seed.json'),
    JSON.stringify(
      {
        ...seeded,
        handoffProjectId: projectId,
        handoffSessions: sessions,
        eligibleHandoffSessions: eligible,
        evaluationCases: { file: casesFile, count: cases.length, ids: cases.map((value) => value.id) },
        upstreamCalls: 0,
      },
      null,
      2
    )
  );
}

export function prepareConfigurationFixture(seeded, artifacts) {
  assertOwnedSeed(seeded);
  const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(marker.root, seeded.root);
  const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
  for (const id of ['connection-fixture-alpha', 'connection-fixture-beta']) {
    const account = db.prepare('SELECT provider, data FROM providerConnections WHERE id=?').get(id);
    assert.equal(account.provider, 'openai');
    const data = JSON.parse(account.data);
    for (const key of ['apiKey', 'accessToken', 'refreshToken', 'password']) assert.ok(!data[key]);
    data.maxConcurrent = 2;
    data.providerSpecificData = {
      ...data.providerSpecificData,
      enabledModels: ['gpt-4o', 'gpt-4o-mini'],
    };
    db.prepare('UPDATE providerConnections SET isActive=0, data=? WHERE id=?').run(
      JSON.stringify(data),
      id
    );
  }
  db.close();
  writeFileSync(
    join(artifacts, 'synthetic-seed.json'),
    JSON.stringify(
      {
        ...seeded,
        disabledCredentiallessAccounts: ['connection-fixture-alpha', 'connection-fixture-beta'],
        upstreamCalls: 0,
      },
      null,
      2
    )
  );
}

export function prepareRouteSimulationFixture(seeded, artifacts) {
  assertOwnedSeed(seeded);
  const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(marker.root, seeded.root);
  const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
  for (const id of ['connection-fixture-alpha', 'connection-fixture-beta']) {
    const account = db.prepare('SELECT provider, data FROM providerConnections WHERE id=?').get(id);
    assert.equal(account.provider, 'openai');
    const data = JSON.parse(account.data);
    for (const key of ['apiKey', 'accessToken', 'refreshToken', 'password']) assert.ok(!data[key]);
    data.providerSpecificData = {
      ...data.providerSpecificData,
      enabledModels: ['gpt-4o', 'gpt-4o-mini'],
    };
    db.prepare('UPDATE providerConnections SET isActive=1, data=? WHERE id=?').run(
      JSON.stringify(data),
      id
    );
  }
  db.close();
  writeFileSync(
    join(artifacts, 'synthetic-seed.json'),
    JSON.stringify(
      {
        ...seeded,
        activeCredentiallessAccounts: ['connection-fixture-alpha', 'connection-fixture-beta'],
        upstreamCalls: 0,
      },
      null,
      2
    )
  );
}

export function prepareNotificationFixture(seeded, artifacts) {
  assertOwnedSeed(seeded);
  const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(marker.root, seeded.root);

  // The account this journey authorizes must be selectable, because
  // eligibility() refuses an inactive account with 'account_unavailable'
  // (src/lib/notifications/remediation.mjs:113). The seed leaves every fixture
  // account credentialless AND inactive, so activation here is the synthetic
  // precondition, never a credential.
  const account = 'connection-fixture-alpha';
  const failures = [];
  const db = new DatabaseSync(join(seeded.root, 'runtime/db/data.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const stored = db.prepare('SELECT provider, data FROM providerConnections WHERE id=?').get(account);
    assert.equal(stored.provider, 'openai');
    for (const key of ['apiKey', 'accessToken', 'refreshToken', 'password']) assert.ok(!JSON.parse(stored.data)[key]);
    db.prepare('UPDATE providerConnections SET isActive=1 WHERE id=?').run(account);
    // Retained failed operations for this exact account. These are the rows the
    // alert's evidence refs must resolve to, so the drain path is exercised
    // against real retained records rather than a fabricated reference.
    const insert = db.prepare(`INSERT INTO operationEvents(operationId,phase,state,source,actorClass,subjectKind,subjectId,provider,connectionId,occurredAt,capturedAt,code,details)
      VALUES(?,?,'failed','synthetic-bounded-remediation-fixture','background','connection',?,?,?,?,?,?,?)`);
    for (let index = 0; index < 3; index++) {
      const at = new Date(Date.parse(seeded.clock) - (180 - index * 20) * 1000).toISOString();
      const result = insert.run(`synthetic-bounded-remediation-${index}`, 'reachability', account, 'openai', account, at, at,
        'synthetic_failed_operation', JSON.stringify({ synthetic: true, reason: 'Injected retained failure for the bounded remediation acceptance.' }));
      failures.push(String(result.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  writeFileSync(
    join(artifacts, 'synthetic-seed.json'),
    JSON.stringify({ ...seeded, activatedAccount: account, syntheticFailedOperationEventIds: failures, upstreamCalls: 0, providerCalls: 0 }, null, 2)
  );
  return { account, failures };
}

export function prepareCompatibilityFixture(seeded) {
  assertOwnedSeed(seeded);
  const owner=JSON.parse(readFileSync(join(seeded.root,'owner.json'),'utf8'));
  writeFileSync(join(seeded.root,'compatibility-gateway.json'),JSON.stringify({kind:'compatibility-gateway-v1',root:owner.root,runId:owner.runId}),{mode:0o600});
  const db=new DatabaseSync(join(seeded.root,'runtime/db/data.sqlite'));
  db.exec('UPDATE providerConnections SET isActive=0');
  db.prepare('UPDATE providerConnections SET isActive=1,data=? WHERE id=?').run(JSON.stringify({testStatus:'active'}),'connection-fixture-alpha');
  db.close();
}

const workflows = {
  'shaping-completion-acceptance.mjs': { scenario: 'representative', prepare: prepareShapingFixture },
  'configuration-domains-acceptance.mjs': { scenario: 'populated', prepare: prepareConfigurationFixture },
  'route-simulation-acceptance.mjs': { scenario: 'populated', prepare: prepareRouteSimulationFixture },
  'notification-automation-acceptance.mjs': { scenario: 'populated', prepare: prepareNotificationFixture },
  'compatibility-qualification.spec.mjs': { scenario: 'populated', prepare: prepareCompatibilityFixture },
  'client-integration.spec.mjs': { scenario: 'populated' },
};
export function browserWorkflowScenario(file) { return workflows[basename(file)]?.scenario || 'representative'; }
export function prepareBrowserWorkflow(file, seeded, artifacts) {
  const prepared = workflows[basename(file)]?.prepare?.(seeded, artifacts);
  return prepared?.account ? [prepared.account, prepared.failures.join(',')] : [];
}
