import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeBinary, nativeSandbox } from './native-sandbox.mjs';
const artifacts=resolve(process.argv[2]),root=mkdtempSync(join(tmpdir(),'tokenproxy-native-context-'));
mkdirSync(join(root,'config'));mkdirSync(join(root,'work'));mkdirSync(join(root,'home'));
const binary=nativeBinary(),sandbox=nativeSandbox(root),policy=sandbox.description;
writeFileSync(join(root,'settings.json'),JSON.stringify({autoCompactWindow:1000000,env:{CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'100'}}));
const cases=[];
for(const model of ['claude-fable-5','claude-fable-5[1m]','claude-fable-5-1','claude-fable-5-1[1m]','claude-opus-5','claude-opus-5[1m]']){
 const debug=join(root,`${cases.length}.debug`),args=[...sandbox.prefix,binary,'--bare','--print','/context','--model',model,'--settings',join(root,'settings.json'),'--debug-file',debug,'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];
 const output=execFileSync(sandbox.command,args,{cwd:join(root,'work'),env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:join(root,'home'),CLAUDE_CONFIG_DIR:join(root,'config'),ANTHROPIC_BASE_URL:'http://127.0.0.1:9',ANTHROPIC_AUTH_TOKEN:'synthetic-no-provider',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},encoding:'utf8',timeout:20000,maxBuffer:1048576});
 assert.match(output,/Context Usage/);const window=output.match(/\*\*Tokens:\*\*.*?\/\s*([^\s(]+)/)?.[1];assert.ok(window);
 const debugFields=readFileSync(debug,'utf8').split('\n').filter(line=>/autocompact:/.test(line)).map(line=>line.match(/(?:tokens|effectiveWindow|threshold|window|source|level)=[a-zA-Z0-9_-]+/g));
 cases.push({model,window,output,debugFields,args,exitCode:0});
}
for(const row of cases)assert.equal(row.window,row.model.includes('[1m]')?'1m':'200k');
writeFileSync(join(artifacts,'native-context.json'),JSON.stringify({binary,platform:process.platform,root,scope:'native built-in /context in isolated gateway configuration; no conversation',settings:{autoCompactWindow:1000000,percentOverride:100},networkPolicy:policy,providerRequests:0,cases},null,2));
console.log('PASS native /context: three bare gateway models report200k; same exact models with[1m] report1m despite identical autoCompactWindow1m; 0 provider calls');
