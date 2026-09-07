import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { credentiallessDatabase } from '../e2e/capacity-economics-fixture-guard.mjs';

const accounts = [
  {id:'connection-fixture-alpha',provider:'openai',name:'Synthetic Alpha'},
  {id:'connection-fixture-beta',provider:'openai',name:'Synthetic Beta'},
  {id:'capacity-fixture-a',provider:'codex',name:'Synthetic research'},
  {id:'capacity-fixture-b',provider:'codex',name:'Synthetic batch'},
];
let root, dataDir, db;
const key = 'deterministic-test-only-fixture-key';
function encrypt(value, password = key) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(password).digest(),iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return `enc1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}
function guard(options={}) { return credentiallessDatabase({dataDir,fixtureRoot:root,...options}); }
beforeEach(()=>{
  root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'capacity-guard-')));dataDir=path.join(root,'runtime','db');mkdirSync(dataDir,{recursive:true});
  writeFileSync(path.join(root,'fixture-manifest.json'),JSON.stringify({version:'operator-workspace-v2',source:'synthetic-local-policy',inferenceAllowed:false,accounts}));
  db=new DatabaseSync(path.join(dataDir,'data.sqlite'));db.exec('CREATE TABLE providerConnections(id TEXT PRIMARY KEY,provider TEXT,name TEXT,data TEXT)');
  for(const account of accounts)db.prepare('INSERT INTO providerConnections VALUES(?,?,?,?)').run(account.id,account.provider,account.name,JSON.stringify(account));
});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
describe('disposable Capacity fixture guard',()=>{
  it('permits exact plain fixture readback and temporary-directory compatibility',()=>{
    let read=guard();expect(read.prepare('SELECT count(*) AS n FROM providerConnections').get().n).toBe(4);read.close();
    read=guard({fixtureRoot:undefined});read.close();
  });
  it('permits names in their schema column with empty plain or encrypted extras',()=>{
    for(const data of ['{}',encrypt({})]) {
      db.prepare('UPDATE providerConnections SET data=?').run(data);
      const read=guard({key});
      try { expect(read.prepare('SELECT id,provider,name FROM providerConnections ORDER BY id').all()).toEqual([...accounts].sort((a,b)=>a.id.localeCompare(b.id))); }
      finally { read.close(); }
    }
  });
  it.each([null,'','Operator account'])('rejects an invalid schema name despite a Synthetic name in extras',name=>{
    db.prepare('UPDATE providerConnections SET name=? WHERE id=?').run(name,accounts[0].id);
    expect(()=>guard()).toThrow('fixture account name is missing its Synthetic prefix');
  });
  it('permits encrypted synthetic configuration on a subsequent run without reading auth files',()=>{
    for(const account of accounts)db.prepare('UPDATE providerConnections SET data=? WHERE id=?').run(encrypt({...account,providerSpecificData:{enabledModels:['gpt-fixture'],accessToken:null}}),account.id);
    for(let run=0;run<2;run++){const read=guard({key});read.close();}
  });
  it.each([undefined,'wrong-fixture-key'])('refuses encrypted rows without the matching explicitly supplied key', supplied=>{
    db.prepare('UPDATE providerConnections SET data=? WHERE id=?').run(encrypt(accounts[0]),accounts[0].id);
    expect(()=>guard({key:supplied})).toThrow('connection data could not be safely decoded');
  });
  it('rejects deeply nested usable credentials after decryption without exposing them',()=>{
    const secret='test-secret-that-must-not-appear-in-errors';
    db.prepare('UPDATE providerConnections SET data=? WHERE id=?').run(encrypt({...accounts[0],providerSpecificData:{nested:[{access_token:secret}]}}),accounts[0].id);
    let failure;try{guard({key});}catch(error){failure=error;}
    expect(failure?.message).toBe('Synthetic fixture refused: usable credential data is present');expect(failure?.message).not.toContain(secret);
  });
  it.each(['id','provider','name'])('rejects a changed %s in the persisted fixture',field=>{
    if(field==='id')db.prepare('UPDATE providerConnections SET id=? WHERE id=?').run('not-a-fixture',accounts[0].id);
    else if(field==='provider')db.prepare('UPDATE providerConnections SET provider=? WHERE id=?').run('another',accounts[0].id);
    else db.prepare('UPDATE providerConnections SET data=? WHERE id=?').run(JSON.stringify({...accounts[0],name:'A real account'}),accounts[0].id);
    expect(()=>guard()).toThrow('Synthetic fixture refused');
  });
  it.each(['version','provider','name','count'])('rejects an incompatible manifest %s',change=>{
    const manifestPath=path.join(root,'fixture-manifest.json'), manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(change==='version')manifest.version='production';else if(change==='count')manifest.accounts.pop();else manifest.accounts[0][change]='mismatch';
    writeFileSync(manifestPath,JSON.stringify(manifest));expect(()=>guard()).toThrow('Synthetic fixture refused');
  });
  it('refuses a different explicit root and a symlinked root',()=>{
    expect(()=>guard({fixtureRoot:path.join(root,'runtime')})).toThrow('canonical runtime root');
    const alias=path.join(root,'alias');symlinkSync(root,alias);expect(()=>guard({fixtureRoot:alias})).toThrow('canonical runtime root');
  });
});
