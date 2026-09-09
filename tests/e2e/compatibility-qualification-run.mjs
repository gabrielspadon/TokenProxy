import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=resolve(process.argv[2] || '/tmp/compatibility-qualification-evidence');
mkdirSync(artifacts,{recursive:true});
const launch=(...args)=>JSON.parse(execFileSync(process.execPath,[join(project,'scripts/redesign-preview.mjs'),...args],{cwd:project,encoding:'utf8',maxBuffer:8*1024*1024}));
const seeded=launch('seed','--mode','dev','--scenario','populated');
const owner=JSON.parse(readFileSync(join(seeded.root,'owner.json'),'utf8'));
writeFileSync(join(seeded.root,'compatibility-gateway.json'),JSON.stringify({kind:'compatibility-gateway-v1',root:owner.root,runId:owner.runId}),{mode:0o600});
const db=new DatabaseSync(join(seeded.root,'runtime/db/data.sqlite'));
db.exec('UPDATE providerConnections SET isActive=0');
db.prepare('UPDATE providerConnections SET isActive=1,data=? WHERE id=?').run(JSON.stringify({testStatus:'active'}),'connection-fixture-alpha');
db.close();
let started=false;
try {
 launch('start','--mode','dev','--run',seeded.root);started=true;
 execFileSync(process.execPath,[join(project,'tests/e2e/compatibility-qualification.spec.mjs'),seeded.root,artifacts],{cwd:project,stdio:'inherit',timeout:240000});
}finally{if(started)writeFileSync(join(artifacts,'stopped.json'),JSON.stringify(launch('stop','--run',seeded.root),null,2));}
