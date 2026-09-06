import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const baselineRef=process.argv[2];
if(!baselineRef)throw new Error('Provide an explicit baseline revision');
const relative='open-sse/providers/pricing.js';
const source=readFileSync(new URL(relative,`file://${root}`),'utf8');
const baselineSource=execFileSync('git',['show',`${baselineRef}:${relative}`],{cwd:root,encoding:'utf8'});
const load=source=>import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const [before,after]=await Promise.all([load(baselineSource),load(source)]);
const cases=before.PATTERN_PRICING.flatMap(({pattern})=>[[pattern,pattern.replaceAll('*','fixture')],[pattern,'unrecognized-fixture-model']]);
for(const [pattern,model] of cases)if(before.matchPattern(pattern,model)!==after.matchPattern(pattern,model))throw new Error('Pattern output changed');
const calls=20000,warmup=10000;
function run(module,count){let matches=0;const started=performance.now();for(let i=0;i<count;i++){const [pattern,model]=cases[i%cases.length];matches+=module.matchPattern(pattern,model)?1:0;}return{milliseconds:performance.now()-started,matches};}
run(before,warmup);run(after,warmup);
const samples=[];
for(let i=0;i<7;i++){
 let baseline,candidate;
 if(i%2){candidate=run(after,calls);baseline=run(before,calls);}else{baseline=run(before,calls);candidate=run(after,calls);}
 if(baseline.matches!==candidate.matches)throw new Error('Timed result mismatch');samples.push({baselineMs:baseline.milliseconds,candidateMs:candidate.milliseconds});
}
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const baselineMs=median(samples.map(s=>s.baselineMs)),candidateMs=median(samples.map(s=>s.candidateMs));
console.log(JSON.stringify({scope:'pattern-matching kernel, not HTTP latency',baselineRef,sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:createHash('sha256').update(source).digest('hex'),node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0].model,calls,warmup,pairs:7,patterns:cases.length/2,samples,median:{baselineMs,candidateMs,speedup:baselineMs/candidateMs}},null,2));
