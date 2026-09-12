// Passive, bounded matching of credentials already available to this process.
// Receipts contain salted fingerprints and counters, never matched text.
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const SINKS = ['api', 'exception', 'log', 'trace'];
const SECRET_NAMES = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|token|authorization)$/i;
const ENV_NAMES = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|ENCRYPTION_KEY)$/;
const sha = value => createHash('sha256').update(value).digest('hex');
function processIdentity() {
  const read = name => { try { return fs.readFileSync(name, 'utf8').trim(); } catch { return null; } };
  const stat = read(`/proc/${process.pid}/stat`);
  return { id: randomUUID(), pid:process.pid, hostname:os.hostname(), bootId:read('/proc/sys/kernel/random/boot_id'),
    startTicks:stat?.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19] ?? null, startedAt:new Date().toISOString() };
}
function createLiveSafety({ env=process.env, identity=processIdentity(), maxSecrets=128, maxSecretBytes=4096,
  maxStreams=512, source={}, now=()=>new Date().toISOString() }={}) {
  const salt = randomBytes(32), secrets = new Map(), streams = new Set(), traceStreams = new Map();
  const sinks = Object.fromEntries(SINKS.map(name=>[name,{writes:0,bytes:0,matches:0,errors:0,observed:false}]));
  const findings = new Map();
  const deliveries = new Map(), responseContexts = new WeakMap(), deliveryContext = new AsyncLocalStorage();
  const issues = new Map();
  let inventoryBytes=0, calls=0, environmentDigest=null, environmentChanges=0;
  const trace = {requestLogsEnabledEver:false,otlpEnabledEver:false,configChanges:0};
  let lastMode;
  function issue(reason) { issues.set(reason,(issues.get(reason)||0)+1); }
  function traceMode() {
    const mode={requestLogs:env.ENABLE_REQUEST_LOGS==='true',otlp:env.TOKENPROXY_TELEMETRY==='otlp'};
    if(lastMode && JSON.stringify(lastMode)!==JSON.stringify(mode)) trace.configChanges++;
    trace.requestLogsEnabledEver ||= mode.requestLogs;
    trace.otlpEnabledEver ||= mode.otlp;
    lastMode=mode;
    return mode;
  }
  function register(value) {
    if(value==null || value==='') return;
    if(typeof value!=='string') { issue('unsupported-credential-type'); return; }
    const length=Buffer.byteLength(value);
    if(length<8 || length>maxSecretBytes) { issue('unsupported-credential-length'); return; }
    const fingerprint=createHmac('sha256',salt).update(value).digest('hex');
    if(secrets.has(fingerprint)) return;
    if(secrets.size>=maxSecrets) { issue('credential-inventory-cap'); return; }
    const bytes=Buffer.from(value);
    secrets.set(fingerprint,bytes); inventoryBytes+=bytes.length;
  }
  function environmentCredentials() {
    const fingerprints=[];
    for(const [name,value] of Object.entries(env)) if(ENV_NAMES.test(name) && typeof value==='string' && value) {
      register(value);
      const bounded=Buffer.byteLength(value)<=maxSecretBytes?value:'unsupported-length';
      fingerprints.push(createHmac('sha256',salt).update(name).update('\0').update(bounded).digest('hex'));
    }
    const next=sha(JSON.stringify(fingerprints.sort()));
    if(environmentDigest && environmentDigest!==next) environmentChanges++;
    environmentDigest=next;
  }
  function traceBegin(slot) {
    for(const [key,capture] of traceStreams) if(key.startsWith(`${slot}:`)) { capture.close(); traceStreams.delete(key); }
  }
  function traceWrite(slot,filename,text) {
    const key=`${slot}:${filename}`;
    if(!traceStreams.has(key)) {
      if(traceStreams.size>=maxStreams) { issue('trace-stream-cap'); return; }
      traceStreams.set(key,stream('trace'));
    }
    traceStreams.get(key).write(text);
  }
  function credentials(value) {
    // Only own data properties, with a hard traversal budget. Getters and
    // arbitrary objects are never invoked by observation.
    const seen=new Set(); let budget=256;
    function walk(object,depth=0) {
      if(!object || typeof object!=='object' || seen.has(object)) return;
      if(depth>4 || --budget<0) { issue('credential-object-cap'); return; }
      seen.add(object);
      for(const name in object) {
        if(--budget<0) { issue('credential-object-cap'); return; }
        const descriptor=Object.getOwnPropertyDescriptor(object,name);
        if(!descriptor || !('value' in descriptor)) { issue('credential-accessor'); continue; }
        const item=descriptor.value;
        if(SECRET_NAMES.test(name)) register(item);
        else if(item && typeof item==='object') walk(item,depth+1);
      }
    }
    try { walk(value); } catch { issue('credential-observer-error'); }
  }
  function stream(sink,authorized=()=>null) {
    if(!sinks[sink]) throw new Error('Unknown safety sink');
    sinks[sink].observed=true;
    if(streams.size>=maxStreams) { issue('sink-stream-cap'); return {write(){},close(){}}; }
    let tail=Buffer.alloc(0), closed=false;
    const state={
      write(chunk,encoding) {
        if(closed || chunk==null || typeof chunk==='function') return;
        try {
          const string=typeof chunk==='string';
          const bytes=Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength) : null;
          const codec=typeof encoding==='string'?encoding.toLowerCase():'utf8';
          if(!string&&!bytes) { issue('unsupported-sink-chunk'); return; }
          if(string&&!['utf8','utf-8','ascii','latin1','binary','ucs2','ucs-2','utf16le','utf-16le'].includes(codec)) {issue('unsupported-sink-encoding');return;}
          sinks[sink].writes++;
          function* pieces() {
            const length=string?chunk.length:bytes.length;
            for(let start=0;start<length;) {
              let end=Math.min(start+16384,length);
              if(string&&end<length&&['utf8','utf-8'].includes(codec)
                &&chunk.charCodeAt(end-1)>=0xd800&&chunk.charCodeAt(end-1)<=0xdbff) end--;
              yield string?Buffer.from(chunk.slice(start,end),codec):bytes.subarray(start,end);
              start=end;
            }
          }
          // Process arbitrarily large writes in fixed slices. Only the suffix
          // needed for split matches lives until the next write or close.
          for(const part of pieces()) {
            sinks[sink].bytes+=part.length;
            const joined=Buffer.concat([tail,part]);
            for(const [fingerprint,secret] of secrets) {
              let offset=0;
              while((offset=joined.indexOf(secret,offset))>=0) {
                if(offset+secret.length>tail.length) {
                  const policy=authorized(fingerprint);
                  const target=policy?deliveries:findings,key=policy?`${policy}:${fingerprint}`:`${sink}:${fingerprint}`;
                  target.set(key,(target.get(key)||0)+1); sinks[sink].matches++;
                }
                offset++;
              }
            }
            const next=Buffer.from(joined.subarray(Math.max(0,joined.length-maxSecretBytes+1)));
            tail.fill(0); joined.fill(0); tail=next;
          }
        } catch { sinks[sink].errors++; issue('sink-observer-error'); }
      },
      close() { if(!closed) { closed=true; tail.fill(0); tail=Buffer.alloc(0); streams.delete(state); } },
    };
    streams.add(state); return state;
  }
  function scan(sink,chunk,encoding) { const capture=stream(sink); capture.write(chunk,encoding); capture.close(); }
  function wrapWritable(target,sink,method='write',capture=stream(sink)) {
    const original=target[method];
    if(typeof original!=='function') { issue('missing-sink-method'); return ()=>{}; }
    function wrapped(...args) { capture.write(args[0],args[1]); return Reflect.apply(original,this,args); }
    target[method]=wrapped;
    return ()=>{ if(target[method]===wrapped) target[method]=original; capture.close(); };
  }
  function observe(req,res) {
    calls++;
    environmentCredentials();
    traceMode();
    // HTTP response bodies and headers are covered, including admin API
    // responses. A deliberate credential disclosure still requires review.
    const pathname=String(req.url||'').split('?',1)[0];
    const policy=req.method!=='POST'?null:pathname==='/api/keys'?'client-key-create'
      :/^\/api\/keys\/[^/]+\/reveal$/.test(pathname)?'client-key-reveal'
      :/^\/api\/keys\/[^/]+\/rotate$/.test(pathname)?'client-key-rotate':null;
    const context={policy,allowed:new Set()};responseContexts.set(res,context);
    const capture=stream('api',fingerprint=>res.statusCode>=200&&res.statusCode<300&&context.allowed.has(fingerprint)?context.policy:null);
    const close=()=>capture.close();
    res.once('finish',close); res.once('close',close);
    wrapWritable(res,'api','write',capture);
    wrapWritable(res,'api','end',capture);
    const original=res.writeHead;
    if(typeof original==='function') res.writeHead=function(...args) {
      try {
        const existing=this.getHeaders?.() || {};
        const supplied=typeof args[1]==='object'?args[1]:args[2];
        scan('api',JSON.stringify([existing,supplied ?? null]));
      } catch { issue('header-observer-error'); }
      return Reflect.apply(original,this,args);
    };
  }
  function run(res,callback) { return deliveryContext.run(responseContexts.get(res),callback); }
  function authorizeDelivery(policy,credential) {
    const context=deliveryContext.getStore();
    if(!context || !policy || context.policy!==policy) {issue('credential-delivery-context-missing');return;}
    register(credential);
    if(typeof credential!=='string'||Buffer.byteLength(credential)>maxSecretBytes) return;
    const fingerprint=createHmac('sha256',salt).update(credential).digest('hex');
    if(secrets.has(fingerprint)) context.allowed.add(fingerprint);
  }
  function snapshot() {
    environmentCredentials();
    const mode=traceMode();
    const counters=Object.fromEntries(SINKS.map(name=>[name,{...sinks[name]}]));
    const unobservable=[...issues].map(([reason,count])=>({reason,count}));
    if(trace.otlpEnabledEver) unobservable.push({reason:'otlp-export-bytes-unobserved',count:1});
    return { schemaVersion:1,kind:'live-secret-snapshot',scope:'configured-credential-literal-bytes',
      process:identity,source,capturedAt:now(),calls,inventory:{count:secrets.size,bytes:inventoryBytes,
        fingerprints:[...secrets.keys()].sort(),retention:'process-lifetime',maxSecrets,maxSecretBytes},
      environment:{digest:environmentDigest,changes:environmentChanges},
      sinks:counters,trace:{...trace,current:mode},
      findings:[...findings].map(([key,count])=>{const [sink,fingerprint]=key.split(':');return {sink,fingerprint,count};}),
      authorizedDeliveries:[...deliveries].map(([key,count])=>{const [policy,fingerprint]=key.split(':');return {sink:'api',policy,fingerprint,count};}),
      unobservable,limitations:['unknown-credentials','encoded-or-transformed-credentials','unregistered-external-sinks'],
    };
  }
  traceMode();
  environmentCredentials();
  return {register,credentials,stream,scan,wrapWritable,observe,snapshot,traceMode,traceBegin,traceWrite,issue,run,authorizeDelivery};
}
function installLiveSafety(root=__dirname) {
  if(globalThis.__tokenproxyLiveSafety) return globalThis.__tokenproxyLiveSafety;
  const source={};
  for(const name of ['live-safety-runtime.cjs','custom-server.js','BUILD_SHA']) {
    try { source[name]=sha(fs.readFileSync(path.join(root,name))); } catch { source[name]=null; }
  }
  try { source.buildSha=fs.readFileSync(path.join(root,'BUILD_SHA'),'utf8').trim(); } catch { source.buildSha=null; }
  const runtime=createLiveSafety({source});
  globalThis.__tokenproxyLiveSafety=runtime;
  runtime.wrapWritable(process.stdout,'log');
  runtime.wrapWritable(process.stderr,'exception');
  return runtime;
}
module.exports={createLiveSafety,installLiveSafety};
