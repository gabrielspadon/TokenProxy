import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
const project=resolve('.'),artifacts=resolve(process.argv[2]);mkdirSync(artifacts,{recursive:true});
const launch=(...args)=>JSON.parse(execFileSync(process.execPath,[join(project,'scripts/redesign-preview.mjs'),...args],{cwd:project,encoding:'utf8',maxBuffer:8*1024*1024}));
const seeded=launch('seed','--mode','dev','--scenario','populated');let started=false;
try{launch('start','--mode','dev','--run',seeded.root);started=true;execFileSync(process.execPath,[join(project,'tests/e2e/client-integration.spec.mjs'),seeded.root,artifacts],{cwd:project,stdio:'inherit',timeout:180000});}
finally{if(started)writeFileSync(join(artifacts,'stopped.json'),JSON.stringify(launch('stop','--run',seeded.root),null,2));}
