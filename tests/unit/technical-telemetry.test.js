import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpTelemetry, technicalRoute } from '../../src/lib/observability/httpTelemetry.js';
import { createTechnicalTelemetry, telemetryOptions } from '../../src/lib/observability/technicalTelemetry.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture({ throws = false } = {}) {
  const values = [], spans = [];
  const instrument = name => ({ add(value,attributes) { if (throws) throw new Error('fixture exporter failure'); values.push({ name,value,attributes }); },
    record(value,attributes) { if (throws) throw new Error('fixture exporter failure'); values.push({ name,value,attributes }); }, addCallback() {} });
  const meter = { createHistogram: instrument, createCounter: instrument, createUpDownCounter: instrument, createObservableGauge: instrument };
  const tracer = { startSpan(name,{attributes},context) { const span = { name,attributes,context,end: vi.fn(),setAttributes(value) { Object.assign(this.attributes,value); }, setStatus: vi.fn() }; spans.push(span); return span; } };
  const eventLoop = { enable: vi.fn(),disable: vi.fn() };
  let now = 0;
  const runtime = createHttpTelemetry({ tracer,meter,eventLoop,rootContext:'empty-root',clock: () => ++now });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false,
    write: vi.fn(() => false), end: vi.fn(() => 'end-result') });
  return { runtime,response,values,spans,eventLoop };
}

it('is disabled by default and rejects ambiguous collector configuration', () => {
  expect(telemetryOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://unexpected.invalid' })).toBeNull();
  expect(telemetryOptions({ TOKENPROXY_TELEMETRY: 'otlp', TOKENPROXY_OTEL_ENDPOINT: 'http://127.0.0.1:4318/' }))
    .toEqual({ endpoint:'http://127.0.0.1:4318',sampleRatio:.01 });
  for (const endpoint of ['', 'file:///private', 'http://user:secret@localhost', 'http://localhost?key=secret', 'http://localhost/#secret']) {
    expect(() => telemetryOptions({ TOKENPROXY_TELEMETRY:'otlp', TOKENPROXY_OTEL_ENDPOINT:endpoint })).toThrow();
  }
  for (const ratio of ['', '-1', '2', 'NaN']) expect(() => telemetryOptions({ TOKENPROXY_TELEMETRY:'otlp', TOKENPROXY_OTEL_ENDPOINT:'http://localhost',TOKENPROXY_OTEL_SAMPLE_RATIO:ratio })).toThrow();
});

it('uses fixed route classes without identifiers or query dimensions', () => {
  expect(technicalRoute('/v1/messages?api_key=secret')).toBe('generation');
  expect(technicalRoute('/api/keys/secret-identifier/reveal')).toBe('operator-api');
  expect(technicalRoute('/dashboard/sessions/secret')).toBe('workspace');
  expect(technicalRoute('/arbitrary-sensitive-name')).toBe('other');
});

it('holds the active measure until response completion and finalizes once', () => {
  const {runtime,response,values,spans} = fixture();
  const originalWrite = response.write, originalEnd = response.end, callback = vi.fn();
  runtime.observe({ method:'POST',url:'/v1/messages?secret=fixture',headers:{ authorization:'private' } },response);
  expect(values.filter(v=>v.name==='tokenproxy.http.active').map(v=>v.value)).toEqual([1]);
  expect(response.write('data: fixture\n\n','utf8',callback)).toBe(false);
  expect(originalWrite).toHaveBeenCalledWith('data: fixture\n\n','utf8',callback);
  expect(response.end('last',callback)).toBe('end-result');
  expect(originalEnd).toHaveBeenCalledWith('last',callback);
  response.writableFinished = true; response.emit('finish'); response.emit('close');
  expect(values.filter(v=>v.name==='tokenproxy.http.active').map(v=>v.value)).toEqual([1,-1]);
  expect(values.filter(v=>v.name==='tokenproxy.http.first_body_write')).toHaveLength(1);
  expect(spans[0].end).toHaveBeenCalledTimes(1);
  expect(spans[0].context).toBe('empty-root');
  expect(response.listenerCount('finish')+response.listenerCount('close')+response.listenerCount('error')).toBe(0);
  expect(response.write).toBe(originalWrite); expect(response.end).toBe(originalEnd);
  expect(JSON.stringify(values)).not.toMatch(/private|secret|fixture/);
  runtime.stop();
});

it('records abandonment independently of a provisional successful status', () => {
  const {runtime,response,values,spans} = fixture();
  runtime.observe({method:'POST',url:'/v1/chat/completions'},response);
  response.emit('close');
  expect(values.find(v=>v.name==='tokenproxy.http.completed').attributes['tokenproxy.outcome']).toBe('aborted');
  expect(spans[0].end).toHaveBeenCalledOnce();
  expect(values.some(v=>v.name==='tokenproxy.http.first_body_write')).toBe(false);
  runtime.stop();
});

it('ends spans and preserves HTTP writes when metric instruments throw', () => {
  const {runtime,response,spans} = fixture({throws:true});
  expect(() => runtime.observe({method:'POST',url:'/v1/messages'},response)).not.toThrow();
  expect(response.write('body')).toBe(false);
  expect(() => response.emit('finish')).not.toThrow();
  expect(spans[0].end).toHaveBeenCalledOnce();
  expect(response.listenerCount('close')).toBe(0);
  runtime.stop();
});

it('does not restore over another owner response wrapper and stops new observations', () => {
  const {runtime,response,eventLoop} = fixture();
  runtime.observe({method:'GET',url:'/api/keys'},response);
  const laterWrapper = () => 'owned-elsewhere'; response.write = laterWrapper;
  response.emit('finish'); expect(response.write).toBe(laterWrapper);
  runtime.stop(); runtime.observe({method:'GET',url:'/'},response);
  expect(response.listenerCount('finish')).toBe(0); expect(eventLoop.disable).toHaveBeenCalledOnce();
});

it('exports real SDK metrics and spans for an actual HTTP response without content or identity', async () => {
  const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace');
  const { InMemoryMetricExporter, AggregationTemporality } = await import('@opentelemetry/sdk-metrics');
  const traceExporter = new InMemorySpanExporter(), metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const runtime = await createTechnicalTelemetry({endpoint:'http://127.0.0.1:1',sampleRatio:1},{traceExporter,metricExporter});
  cleanups.push(()=>runtime.shutdown());
  const server = createServer((req,res) => { runtime.observe(req,res); res.end('private-response-fixture'); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.unshift(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/keys/private-id?token=secret`, {headers:{authorization:'Bearer private-credential'}});
  expect(await response.text()).toBe('private-response-fixture');
  await runtime.forceFlush();
  const spans = traceExporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(spans[0].attributes).toMatchObject({'tokenproxy.route_class':'operator-api','tokenproxy.outcome':'complete'});
  const metrics = metricExporter.getMetrics();
  expect(metrics.flatMap(resource=>resource.scopeMetrics.flatMap(scope=>scope.metrics)).some(metric=>metric.descriptor.name==='tokenproxy.http.completed')).toBe(true);
  expect(JSON.stringify({attributes:spans.map(s=>s.attributes),metrics})).not.toMatch(/private-id|private-credential|private-response-fixture|token=secret/);
});

it('sends bounded OTLP HTTP exports only to the explicit collector', async () => {
  const received = [];
  const server = createServer((req,res) => {
    const chunks = [];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=> { received.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()}); res.setHeader('Content-Type','application/json'); res.end('{}'); });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const runtime = await createTechnicalTelemetry({endpoint:`http://127.0.0.1:${server.address().port}`,sampleRatio:1});
  cleanups.unshift(()=>runtime.shutdown());
  const response = Object.assign(new EventEmitter(),{statusCode:200,writableFinished:true,write:()=>true,end:()=>{}});
  runtime.observe({method:'POST',url:'/v1/messages?api_key=private-fixture'},response);
  response.end('private-content'); response.emit('finish');
  await runtime.forceFlush();
  expect(received.map(item=>item.path).sort()).toEqual(['/v1/metrics','/v1/traces']);
  const documents = received.map(item=>JSON.parse(item.body));
  expect(documents.some(body=>body.resourceSpans?.length)).toBe(true);
  expect(documents.some(body=>body.resourceMetrics?.length)).toBe(true);
  expect(JSON.stringify(received)).not.toMatch(/private-fixture|private-content/);
  expect(received.every(item=>Buffer.byteLength(item.body)<64*1024)).toBe(true);
});

it('drops excess technical spans under exporter pressure while counting every response', async () => {
  const { InMemoryMetricExporter, AggregationTemporality } = await import('@opentelemetry/sdk-metrics');
  let sent = 0, holding = true;
  const pending = [];
  const traceExporter = { export(spans,done) { sent += spans.length; if(holding)pending.push(done);else done({code:0}); }, shutdown: async()=>{} };
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const runtime = await createTechnicalTelemetry({endpoint:'http://127.0.0.1:1',sampleRatio:1},{traceExporter,metricExporter});
  cleanups.push(()=>runtime.shutdown());
  for(let i=0;i<1500;i++) {
    const response = Object.assign(new EventEmitter(),{statusCode:200,writableFinished:true,write:()=>true,end:()=>{}});
    runtime.observe({method:'POST',url:'/v1/messages'},response);response.emit('finish');
  }
  holding = false;for(const done of pending.splice(0))done({code:0});
  await runtime.forceFlush();
  expect(sent).toBeGreaterThan(0);expect(sent).toBeLessThanOrEqual(1152);
  const completed = metricExporter.getMetrics().flatMap(r=>r.scopeMetrics.flatMap(s=>s.metrics)).filter(m=>m.descriptor.name==='tokenproxy.http.completed');
  expect(completed.flatMap(m=>m.dataPoints).reduce((sum,p)=>sum+p.value,0)).toBe(1500);
});

it('zero trace sampling still records unsampled HTTP metrics', async () => {
  const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace');
  const { InMemoryMetricExporter, AggregationTemporality } = await import('@opentelemetry/sdk-metrics');
  const traceExporter = new InMemorySpanExporter(), metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const runtime = await createTechnicalTelemetry({endpoint:'http://127.0.0.1:1',sampleRatio:0},{traceExporter,metricExporter});cleanups.push(()=>runtime.shutdown());
  const response = Object.assign(new EventEmitter(),{statusCode:200,writableFinished:true,write:()=>true,end:()=>{}});
  runtime.observe({method:'POST',url:'/v1/messages'},response);response.emit('finish');await runtime.forceFlush();
  expect(traceExporter.getFinishedSpans()).toHaveLength(0);
  expect(metricExporter.getMetrics().flatMap(r=>r.scopeMetrics.flatMap(s=>s.metrics)).some(m=>m.descriptor.name==='tokenproxy.http.completed')).toBe(true);
});

it('the shipped HTTP wrapper observes actual requests and tolerates observer failure', async () => {
  const original = http.createServer;
  const prior = globalThis.__tokenproxyTechnicalTelemetry;
  const observe = vi.fn(()=>{throw new Error('unavailable instrumentation');});
  globalThis.__tokenproxyTechnicalTelemetry = {observe};
  createRequire(import.meta.url)('../../custom-server.js');
  const server = http.createServer((_req,res)=>res.end('successful-work'));
  cleanups.unshift(async()=>{
    await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
    http.createServer=original;globalThis.__tokenproxyTechnicalTelemetry=prior;
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`);
  expect(await response.text()).toBe('successful-work');expect(observe).toHaveBeenCalledOnce();
});
