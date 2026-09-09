import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(process.argv[2] || '/tmp/shaping-experiments-evidence');
mkdirSync(artifacts, { recursive: true });
const launch = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [join(project, 'scripts/redesign-preview.mjs'), ...args], {
      cwd: project,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  );
const seeded = launch('seed', '--mode', 'dev', '--scenario', 'representative');
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
let started = false;
try {
  launch('start', '--mode', 'dev', '--run', seeded.root);
  started = true;
  execFileSync(
    process.execPath,
    [join(project, 'tests/e2e/shaping-completion-acceptance.mjs'), seeded.root, artifacts],
    { cwd: project, stdio: 'inherit', timeout: 420000 }
  );
} finally {
  if (started)
    writeFileSync(
      join(artifacts, 'stopped.json'),
      JSON.stringify(launch('stop', '--run', seeded.root), null, 2)
    );
}
