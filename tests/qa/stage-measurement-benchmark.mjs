import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Benchmark the exact committed/candidate stage closure from a source snapshot.
// This is an isolated measurement kernel, not an HTTP or gateway latency test.
const [sourcePath, targetKiB = '1024', iterations = '100', enabled = '0'] = process.argv.slice(2);
const source = readFileSync(sourcePath, 'utf8');
const initialize = source.match(/const saverPrev = ([^\n]+);/);
const closure = source.match(/const measureSaverStage = \([\s\S]+?\n  };/);
assert(initialize && closure, 'Cannot identify the measured production closure');
const prepare = new Function('translatedBody', 'toolsAfterBytes', 'contextStages', 'saverStages', 'saverWillRun',
  `const saverPrev = ${initialize[1]}; ${closure[0]}; return measureSaverStage;`);
const row = 'Exact unicode 日本語 🧭, amount -0.001, path /fixture/source.py. ';
const body = { model: 'fixture', messages: [{ role: 'user', content: row.repeat(Math.ceil(Number(targetKiB) * 1024 / Buffer.byteLength(row))) }] };
const stages = ['schema', 'thinking', 'rtk', 'privacy', 'inject', 'pxpipe', 'mem', 'headroom', 'qac', 'pairs', 'reorder'];
const expectedBytes = Buffer.byteLength(JSON.stringify(body));
let receipt;
for (let run = 0; run < Number(iterations); run++) {
  const toolsAfterBytes = Buffer.byteLength(JSON.stringify(body));
  const ledger = [], changed = [];
  const measure = prepare(body, toolsAfterBytes, ledger, changed, true);
  for (let i = 0; i < stages.length; i++) measure(stages[i], i < Number(enabled));
  const finalBytes = Buffer.byteLength(JSON.stringify(body));
  measure('final', true, finalBytes);
  assert.equal(ledger.length, 12);
  assert.equal(changed.length, 0);
  for (const entry of ledger) {
    assert.equal(entry.in, expectedBytes);
    assert.equal(entry.out, expectedBytes);
    assert.equal(entry.delta, 0);
  }
  receipt = ledger;
}
console.log(JSON.stringify({ operation: 'one complete 12-row stage ledger', operations: Number(iterations),
  enabledStages: Number(enabled), bodyBytes: expectedBytes, sourceSha256: createHash('sha256').update(source).digest('hex'),
  ledgerSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), runtime: process.version,
  scope: 'Measurement closure only; fixture construction, assertions and process startup included. No HTTP, provider, persistence or token-cost claim.' }));
