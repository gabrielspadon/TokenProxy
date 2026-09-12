// Builds an isolated synthetic fixture in a separate process so profiling RSS
// starts from a reopened production-shaped database.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirArg=process.argv.find(arg=>arg.startsWith('--data-dir='));
const rowsArg=process.argv.find(arg=>arg.startsWith('--rows='));
const output=process.argv.find((arg,index)=>index>1&&!arg.startsWith('--'));
if(!dataDirArg||!rowsArg||!output)throw new Error('usage: economics-analytics-seed.mjs --data-dir=PATH --rows=N RECEIPT');
const dataDir=resolve(dataDirArg.slice('--data-dir='.length));
const rowsPerTable=Number(rowsArg.slice('--rows='.length));
if(!Number.isSafeInteger(rowsPerTable)||rowsPerTable<1||rowsPerTable>1000000)throw new Error('rows must be 1..1000000');
mkdirSync(dataDir,{recursive:true});
process.env.DATA_DIR=dataDir;
process.chdir(resolve(fileURLToPath(new URL('../..',import.meta.url))));
const started=performance.now();
const [{getAdapter},{seedEconomicsScale}]=await Promise.all([
  import('../../src/lib/db/driver.js'),import('../fixtures/economics-analytics-scale.mjs'),
]);
const db=await getAdapter();
try{
  db.transaction(()=>seedEconomicsScale(db,{rowsPerTable}));
  db.flush?.();
  const requestRows=db.get('SELECT COUNT(*) AS n FROM requestStats').n;
  const usageRows=db.get('SELECT COUNT(*) AS n FROM usageHistory').n;
  const projectionRows=db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection').n;
  const missingRows=db.get('SELECT COUNT(*) AS n FROM usageHistory u LEFT JOIN usageEconomicsProjection p ON p.id=u.id WHERE p.id IS NULL').n;
  const orphanRows=db.get('SELECT COUNT(*) AS n FROM usageEconomicsProjection p LEFT JOIN usageHistory u ON u.id=p.id WHERE u.id IS NULL').n;
  assert.equal(requestRows,rowsPerTable);assert.equal(usageRows,rowsPerTable);assert.equal(projectionRows,rowsPerTable);
  assert.equal(missingRows,0);assert.equal(orphanRows,0);
  const linuxPeak=process.platform==='linux'?Number(readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+) kB$/m)?.[1])*1024:0;
  const receipt={fixture:{version:'economics-analytics-v1',rowsPerTable,requestRows,usageRows,projectionRows,missingRows,orphanRows,synthetic:true},
    constructionDurationMs:performance.now()-started,constructionPeakRssBytes:linuxPeak||process.resourceUsage().maxRSS*1024,externalNetworkAttempts:0,productionDataAccess:false};
  const marker={kind:'tokenproxy-economics-synthetic-fixture',version:1,rowsPerTable,synthetic:true,productionDataAccess:false,completed:true};
  writeFileSync(`${dataDir}/.tokenproxy-economics-fixture.json.tmp`,JSON.stringify(marker)+'\n');
  renameSync(`${dataDir}/.tokenproxy-economics-fixture.json.tmp`,`${dataDir}/.tokenproxy-economics-fixture.json`);
  writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
}finally{db.close();}
