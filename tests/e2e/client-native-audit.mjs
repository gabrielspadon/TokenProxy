import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
const destination=resolve(process.argv[2]);
const audit=String.raw`
from pathlib import Path
import json,re,hashlib,subprocess,os
home=Path.home(); binary=home/'.local/share/claude/versions/2.1.263';data=binary.read_bytes();source=data.decode('utf8','ignore');settings=home/'.claude/settings.json';config=json.loads(settings.read_text())
fragments={}
patterns={'threshold':r'function \w+\(\w+,\w+\)\{let \w+=\w+-13000.{0,350}?return \w+\}', 'effective':r'function \w+\(\w+,\w+\)\{let \w+=Math.min\(\w+\(\w+\),\w+\),.{0,180}?return \w+-\w+\}'}
for key,pattern in patterns.items():
 match=re.search(pattern,source);assert match,key;fragments[key]=match.group()
# Retain the hook ordering slice, which prevents a transcript-read adapter
# from confusing a preceding boundary with the current PostCompact event.
pos=source.find('hookType:"post_compact"',100000000)
if pos>=0:fragments['postCompactOrdering']=source[pos:pos+1600]
registry=home/'Codebases/ai-dotfiles/libexec/generated/routing.json';rd=json.loads(registry.read_text());lanes={k:{f:v.get(f) for f in ['model','context_served','capabilities','autocompact_tokens']} for k,v in rd.get('plain_router',{}).get('lanes',{}).items()}
launcher=home/'Codebases/ai-dotfiles/libexec/shared/bin/cc-router';text=launcher.read_text();start=text.index('context_models=');end=text.index('for model_variable',start)
processes=[]
if Path('/proc').exists():
 for p in Path('/proc').glob('[0-9]*'):
  try:
   exe=(p/'exe').resolve()
   if '/claude/versions/' not in str(exe) and '/ccd-cli/' not in str(exe):continue
   args=(p/'cmdline').read_bytes().split(b'\0');flags={}
   for i,arg in enumerate(args):
    if arg in [b'--model',b'--autocompact',b'--session-id'] and i+1<len(args):flags[arg.decode()]=args[i+1].decode()
   env=dict(item.split(b'=',1) for item in (p/'environ').read_bytes().split(b'\0') if b'=' in item)
   processes.append({'pid':int(p.name),'binary':str(exe),'explicitFlags':flags,'windowEnv':{k.decode():v.decode() for k,v in env.items() if k in [b'CLAUDE_CODE_AUTO_COMPACT_WINDOW',b'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',b'CLAUDE_CODE_DISABLE_1M_CONTEXT',b'CLAUDE_CODE_MAX_CONTEXT_TOKENS']}})
  except (PermissionError,FileNotFoundError,ProcessLookupError):continue
print(json.dumps({'version':subprocess.check_output([str(binary),'--version'],text=True).strip(),'binary':str(binary),'sha256':hashlib.sha256(data).hexdigest(),'settingsPath':str(settings),'selectedSettings':{'model':config.get('model'),'autoCompactWindow':config.get('autoCompactWindow'),'env':{k:v for k,v in config.get('env',{}).items() if k in ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE','CLAUDE_CODE_AUTO_COMPACT_WINDOW','CLAUDE_CODE_MAX_OUTPUT_TOKENS','CLAUDE_CODE_DISABLE_1M_CONTEXT']}},'sourceFragments':fragments,'fragmentHashes':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in fragments.items()},'registry':str(registry),'registryHash':hashlib.sha256(registry.read_bytes()).hexdigest(),'lanes':lanes,'launcher':str(launcher),'launcherHash':hashlib.sha256(launcher.read_bytes()).hexdigest(),'launcherModelSelection':text[start:end],'activeProcesses':processes},indent=2))
`;
for(const host of ['mac','rtx']){
 const output=host==='mac'?execFileSync('python3',['-'],{input:audit,encoding:'utf8',maxBuffer:4*1024*1024}):execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','rtx','python3','-'],{input:audit,encoding:'utf8',maxBuffer:4*1024*1024,timeout:15000});
 const receipt=JSON.parse(output);writeFileSync(join(destination,`native-${host}.json`),JSON.stringify({capturedAt:new Date().toISOString(),host,...receipt},null,2));
}
console.log('PASS native Mac/RTX binary, settings, exact model launcher and source receipts; read-only, credentials excluded');
