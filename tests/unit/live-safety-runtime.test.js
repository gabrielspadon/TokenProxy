import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const {createLiveSafety}=createRequire(import.meta.url)('../../live-safety-runtime.cjs');
const secret='private-fixture-credential-12345';
it('detects a known credential split across writes without exposing bytes in the receipt', () => {
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}}), capture=runtime.stream('api');
  capture.write(`hello ${secret.slice(0,9)}`); capture.write(secret.slice(9)); capture.write(' done'); capture.close();
  expect(runtime.snapshot().findings).toMatchObject([{sink:'api',count:1}]);
  expect(JSON.stringify(runtime.snapshot())).not.toContain(secret);
  expect(JSON.stringify(runtime.snapshot())).not.toContain('hello');
});
it('preserves byte buffers, this, callback arguments, return values and synchronous throws', () => {
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}}), callback=vi.fn();
  const bytes=Buffer.from(secret);
  const target={write:vi.fn(function(chunk,encoding,cb){expect(this).toBe(target);cb();return false;})};
  const original=target.write;
  runtime.wrapWritable(target,'log');
  expect(target.write(bytes,'utf8',callback)).toBe(false);
  expect(bytes.toString()).toBe(secret); expect(callback).toHaveBeenCalledOnce();
  expect(original).toHaveBeenCalledWith(bytes,'utf8',callback);
  const error=new Error('fixture write failure'), broken={write(){throw error;}};
  runtime.wrapWritable(broken,'exception');
  expect(()=>broken.write('body')).toThrow(error);
});
it('observes HTTP writes and headers without changing the response or callbacks', () => {
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}}), res=new EventEmitter(), done=vi.fn();
  res.getHeaders=()=>({'x-fixture':secret});
  res.writeHead=vi.fn(function(){return this;}); res.write=vi.fn(()=>false);
  res.end=vi.fn(function(_chunk,callback){callback();this.emit('finish');return this;});
  runtime.observe({},res);
  expect(res.writeHead(200)).toBe(res); expect(res.write(secret.slice(0,12))).toBe(false);
  expect(res.end(secret.slice(12),done)).toBe(res); expect(done).toHaveBeenCalledOnce();
  expect(runtime.snapshot().sinks.api.matches).toBe(2);
});
it('retains trace mode history and never infers disabled coverage from missing bytes', () => {
  const env={}, runtime=createLiveSafety({env});
  expect(runtime.snapshot().trace).toMatchObject({requestLogsEnabledEver:false,otlpEnabledEver:false});
  env.TOKENPROXY_TELEMETRY='otlp'; runtime.traceMode(); delete env.TOKENPROXY_TELEMETRY;
  expect(runtime.snapshot().unobservable).toContainEqual({reason:'otlp-export-bytes-unobserved',count:1});
});
it('keeps cap, unsupported credentials and unknown token-like generation text distinct', () => {
  const runtime=createLiveSafety({env:{},maxSecrets:1,maxStreams:1});
  runtime.register(secret); runtime.register('second-private-credential'); runtime.register('short');
  const stream=runtime.stream('api'); runtime.stream('log'); stream.write('sk-user-authored-example-not-a-configured-secret');
  expect(runtime.snapshot().findings).toEqual([]);
  expect(runtime.snapshot().unobservable.map(x=>x.reason)).toEqual(['credential-inventory-cap','unsupported-credential-length','sink-stream-cap']);
});
it('matches trace append boundaries and releases old slot suffixes before reuse', () => {
  const runtime=createLiveSafety({env:{JWT_SECRET:secret,ENABLE_REQUEST_LOGS:'true'}});
  runtime.traceWrite(1,'stream.txt',secret.slice(0,5));runtime.traceWrite(1,'stream.txt',secret.slice(5));
  expect(runtime.snapshot().sinks.trace.matches).toBe(1);
  runtime.traceWrite(1,'stream.txt',secret.slice(0,5));runtime.traceBegin(1);runtime.traceWrite(1,'stream.txt',secret.slice(5));
  expect(runtime.snapshot().sinks.trace.matches).toBe(1);
});
it('counts large UTF-8 string writes exactly across surrogate boundaries with bounded slices',()=>{
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}});
  const text='x'.repeat(16383)+'😀'+secret+'y'.repeat(200000);
  runtime.scan('api',text);
  expect(runtime.snapshot().sinks.api).toMatchObject({bytes:Buffer.byteLength(text),writes:1,matches:1,errors:0});
  runtime.scan('api','aGVsbG8=','base64');
  expect(runtime.snapshot().unobservable).toContainEqual({reason:'unsupported-sink-encoding',count:1});
});
it('allows only the code-authorized credential body for the exact successful operator response',async()=>{
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}}),key='issued-client-key-private-12345';
  const response=()=>Object.assign(new EventEmitter(),{statusCode:201,getHeaders:()=>({}),writeHead(){return this;},write(){return false;},end(){this.emit('finish');return this;}});
  const issued=response(),other=response();
  runtime.observe({method:'POST',url:'/api/keys'},issued);runtime.observe({method:'POST',url:'/api/keys'},other);
  await runtime.run(issued,async()=>{await Promise.resolve();runtime.authorizeDelivery('client-key-create',key);});
  issued.write(key.slice(0,10));issued.end(key.slice(10));other.end(key);
  runtime.scan('log',key);
  expect(runtime.snapshot().authorizedDeliveries).toMatchObject([{sink:'api',policy:'client-key-create',count:1}]);
  expect(runtime.snapshot().findings.map(row=>[row.sink,row.count])).toEqual([['api',1],['log',1]]);
  expect(JSON.stringify(runtime.snapshot())).not.toContain(key);
});
it('refuses URL-only authorization, mismatched policies, error responses and credential headers',()=>{
  const runtime=createLiveSafety({env:{JWT_SECRET:secret}});
  const response=(statusCode=200)=>Object.assign(new EventEmitter(),{statusCode,getHeaders:()=>({'x-key':secret}),writeHead(){return this;},write(){return true;},end(){this.emit('finish');return this;}});
  const missing=response(),wrong=response(),failed=response(500),headers=response();
  runtime.observe({method:'POST',url:'/api/keys'},missing);missing.end(secret);
  runtime.observe({method:'POST',url:'/v1/responses'},wrong);runtime.run(wrong,()=>runtime.authorizeDelivery('client-key-create',secret));wrong.end(secret);
  runtime.observe({method:'POST',url:'/api/keys'},failed);runtime.run(failed,()=>runtime.authorizeDelivery('client-key-create',secret));failed.end(secret);
  runtime.observe({method:'POST',url:'/api/keys'},headers);runtime.run(headers,()=>runtime.authorizeDelivery('client-key-create',secret));headers.writeHead(200);headers.end();
  expect(runtime.snapshot().authorizedDeliveries).toEqual([]);expect(runtime.snapshot().sinks.api.matches).toBe(4);
});
