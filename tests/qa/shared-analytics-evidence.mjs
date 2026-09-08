import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), evidence=resolve(process.argv[2]);
const q=JSON.parse(readFileSync(join(evidence,'qualification.json'),'utf8'));
assert.equal(q.passed,true);assert.equal(q.failedTests,0);assert.ok(q.passedTests>=48);assert.equal(q.paidUpstreamCalls,0);
for(const[file,hash]of Object.entries(q.sourceHashes))assert.equal(createHash('sha256').update(readFileSync(join(root,file))).digest('hex'),hash,`Source changed after qualification: ${file}`);
const b=JSON.parse(readFileSync(join(evidence,'browser-receipt.json'),'utf8'));
assert.equal(b.simultaneousSubscribers,2);assert.equal(b.cancelled,2);assert.equal(b.controlSaveUnderPressure,true);assert.deepEqual(b.accountControl,{id:'connection-fixture-alpha',changed:true,restored:true});assert.equal(b.restoredPolicy,true);assert.equal(b.unauthenticatedStatus,401);
assert.equal(b.shared[0].computedAt,b.shared[1].computedAt);assert.equal(b.shared[0].version,b.shared[1].version);assert.equal(b.analytics.length,8);
for(const r of b.analytics){assert.equal(r.status,200);assert.equal(r.projection.mode,'reduced');assert.equal(r.projection.refreshAfterMs,60000);}
assert.deepEqual(b.outboundFailures,[]);assert.equal(b.paidUpstreamCalls,0);assert.equal(b.latencyQualification,false);
assert.deepEqual(b.viewports.map(v=>[v.width,v.height]),[[1440,1000],[1920,1080],[390,844]]);
for(const v of b.viewports){assert.equal(v.overflow,false);assert.ok(readFileSync(v.file).length>1000);}
console.log(`SHARED ANALYTICS EVIDENCE VERIFIED ${q.passedTests} tests; source hashes current; 2 shared subscribers and independent control; 3 viewports; P01 excluded`);
