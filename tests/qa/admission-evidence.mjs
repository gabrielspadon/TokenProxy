import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = resolve(process.argv[2]);
const qualification = JSON.parse(readFileSync(join(evidence, 'qualification.json'), 'utf8'));
assert.equal(qualification.passed, true);
assert.equal(qualification.failedTests, 0);
assert.ok(qualification.passedTests >= 398);
assert.equal(qualification.paidUpstreamCalls, 0);
for (const [file, expected] of Object.entries(qualification.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), expected, `Source changed after qualification: ${file}`);
}
const browser = JSON.parse(readFileSync(join(evidence, 'browser-receipt.json'), 'utf8'));
assert.equal(browser.persistedMaximum, 96);
assert.equal(browser.persistedOverride, 10);
assert.equal(browser.invalidBoundsStatus, 400);
assert.equal(browser.unauthenticatedStatus, 401);
assert.deepEqual(browser.outboundFailures, []);
assert.equal(browser.synthetic, true);
assert.equal(browser.latencyQualification, false);
assert.deepEqual(browser.viewports.map(v => [v.width, v.height]), [[1440,1000],[1920,1080],[390,844]]);
for (const viewport of browser.viewports) {
  assert.equal(viewport.overflow, false);
  assert.ok(readFileSync(viewport.file).length > 1000);
}
console.log(`ADMISSION EVIDENCE VERIFIED ${qualification.passedTests} tests; source hashes current; 3 browser viewports; P01 excluded`);
