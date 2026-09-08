import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBoundedLogSink } from '../../../open-sse/utils/boundedLogSink.js';
import { createRequestLogger, __requestLog } from '../../../open-sse/utils/requestLogger.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-bounded-retention-'));
const cwd = process.cwd();
process.chdir(root);
process.env.ENABLE_REQUEST_LOGS = 'true';
process.env.DATA_DIR = path.join(root, 'data');
const receipt = { runtime: process.version, providerCalls: 0 };
try {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sink = createBoundedLogSink({ maxBytes: 65536, maxRecords: 128, write: () => blocked });
  sink.enqueue('safe', 512);
  await new Promise(setImmediate);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let n = 0; n < 1000000; n++) sink.enqueue('safe', 512);
  global.gc?.();
  const heapDeltaBytes = process.memoryUsage().heapUsed - before;
  assert.ok(heapDeltaBytes < 4 * 1024 * 1024);
  assert.equal(sink.status().bytes, 65536);
  assert.equal(sink.status().records, 128);
  receipt.slowSink = { attempts: 1000001, enqueueMs: performance.now() - start, heapDeltaBytes, ...sink.status() };
  release(); await sink.close();

  const abort = new AbortController();
  const cancelled = await createRequestLogger('openai', 'openai', 'controlled', { signal: abort.signal });
  cancelled.appendProviderChunk('data: {"access_token":"hidden');
  abort.abort();
  cancelled.appendProviderChunk('secret"}\n');
  await cancelled.close();
  assert.equal(cancelled.status().closed, true);
  assert.equal(cancelled.status().frames[0].pendingChars, 0);
  for (let n = 0; n < 70; n++) {
    const logger = await createRequestLogger('openai', 'openai', 'controlled');
    logger.logClientRawRequest('/controlled', { password: 'canary-small-secret', content: 'permitted diagnostic' }, { authorization: 'Bearer canary-secret-123456789' });
    for (let j = 0; j < 400; j++) logger.appendProviderChunk('data: {"delta":"' + 'x'.repeat(1000) + '"}\n');
    await logger.close();
    assert.ok(logger.status().bytes <= __requestLog.SESSION_BYTES);
  }
  await __requestLog.flush();
  const dir = path.join(root, 'logs', 'requests-v2');
  const sessions = await fs.readdir(dir);
  assert.equal(sessions.length, 64);
  let retainedBytes = 0;
  let files = 0;
  for (const session of sessions) {
    let sessionBytes = 0;
    for (const file of await fs.readdir(path.join(dir, session))) {
      const target = path.join(dir, session, file);
      const content = await fs.readFile(target, 'utf8');
      const stat = await fs.stat(target);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.ok(!content.includes('canary-small-secret') && !content.includes('canary-secret-123456789'));
      sessionBytes += stat.size; files++;
    }
    assert.ok(sessionBytes <= __requestLog.SESSION_BYTES);
    retainedBytes += sessionBytes;
  }
  receipt.requestRing = { sessions: sessions.length, files, retainedBytes, maxBytes: 64 * 256 * 1024, queue: __requestLog.status() };
  assert.ok(retainedBytes <= receipt.requestRing.maxBytes);
  const require = createRequire(import.meta.url);
  const mitm = require('../../../src/mitm/logger.js');
  await mitm.ready;
  const req = { method: 'POST', url: '/controlled', headers: { authorization: 'Bearer canary-secret-123456789' } };
  const dumper = mitm.createResponseDumper(req);
  assert.ok(dumper);
  dumper.writeHeader(200, { 'content-encoding': 'gzip', 'set-cookie': 'canary-small-secret' });
  const chunk = Buffer.alloc(1024 * 1024);
  for (let n = 0; n < 1000; n++) dumper.writeChunk(chunk);
  dumper.end(); dumper.end();
  await mitm.flush();
  const data = JSON.parse(await fs.readFile(dumper.file, 'utf8'));
  assert.equal(data.body.bytes, 1000 * 1024 * 1024);
  assert.equal(data.body.omitted, true);
  assert.equal(data.headers['set-cookie'], '[redacted]');
  receipt.mitm = { observedBytes: data.body.bytes, retainedBytes: (await fs.stat(dumper.file)).size };
  process.env.ENABLE_REQUEST_LOGS = 'false';
  assert.equal((await createRequestLogger('x', 'x', 'x')).sessionPath, null);
  assert.equal(mitm.createResponseDumper(req), null);
  receipt.consentOff = true;
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  process.chdir(cwd);
  await fs.rm(root, { recursive: true, force: true });
}
