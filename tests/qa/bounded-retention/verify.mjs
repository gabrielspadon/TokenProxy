import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const evidence = path.resolve(process.argv[2]);
const qualification = JSON.parse(await fs.readFile(path.join(evidence, 'qualification.json'), 'utf8'));
assert.equal(qualification.failed, 0);
assert.equal(qualification.passed, qualification.tests);
for (const [file, expected] of Object.entries(qualification.hashes)) {
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(qualification.repo, file))).digest('hex'), expected, `stale source ${file}`);
}
const runtime = JSON.parse(await fs.readFile(path.join(evidence, 'runtime.json'), 'utf8'));
assert.equal(runtime.providerCalls, 0);
assert.equal(runtime.consentOff, true);
assert.equal(runtime.slowSink.records, 128);
assert.equal(runtime.slowSink.bytes, 65536);
assert.ok(runtime.slowSink.heapDeltaBytes < 4 * 1024 * 1024);
assert.equal(runtime.requestRing.sessions, 64);
assert.ok(runtime.requestRing.retainedBytes <= runtime.requestRing.maxBytes);
assert.equal(runtime.mitm.observedBytes, 1048576000);
const review = await fs.readFile(path.join(evidence, 'REVIEW.md'), 'utf8');
for (const pass of ['Pass 1', 'Pass 2', 'Pass 3', 'Pass 4', 'Parent integration']) assert.ok(review.includes(pass));
console.log(`Bounded retention evidence verified: ${qualification.tests} tests, ${Object.keys(qualification.hashes).length} current source hashes, four passes, bounded offline runtime.`);
