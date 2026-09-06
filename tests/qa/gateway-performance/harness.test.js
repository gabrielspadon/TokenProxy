import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quantiles, requestFailed, outsideProviderMs } from './measurements.mjs';

describe('performance receipt validity', () => {
  const record = () => ({ id: 'a', status: 200, terminal: true, startedAt: 1, useful: [{ id: 'a', index: 0, at: 20 }] });
  it('rejects fast empty, truncated, reordered, duplicated and cross-request output', () => {
    expect(requestFailed({ ...record(), useful: [] })).toBe(true);
    expect(requestFailed({ ...record(), terminal: false })).toBe(true);
    expect(requestFailed({ ...record(), useful: [{ id: 'a', index: 1 }] })).toBe(true);
    expect(requestFailed({ ...record(), useful: [{ id: 'b', index: 0 }] })).toBe(true);
    expect(requestFailed({ ...record(), useful: [...record().useful, ...record().useful] })).toBe(true);
    expect(requestFailed(record())).toBe(false);
  });
  it('keeps intentional cancellation distinct from an upstream or protocol failure', () => {
    expect(requestFailed({ ...record(), abortAt: 21, terminal: false })).toBe(false);
    expect(requestFailed({ ...record(), abortAt: 21, error: 'unrelated' })).toBe(true);
  });
  it('removes provider residence time without silently dropping negative paired differences', () => {
    expect(outsideProviderMs(record(), { receivedAt: 4, writes: [17] })).toBe(6);
    expect(outsideProviderMs({ ...record(), useful: [] }, { receivedAt: 4, writes: [17] })).toBeNaN();
    expect(quantiles([-2, 4, NaN, 5])).toMatchObject({ samples: 3, min: -2, p50: 4, p95: 5, p99: 5 });
    expect(quantiles([NaN])).toMatchObject({ samples: 0, p95: null });
  });
});

it('runtime guard permits numeric loopback bind while denying outbound sockets, DNS and subprocesses', () => {
  const guard = fileURLToPath(new URL('./guard.cjs', import.meta.url));
  const script = `const assert=require('node:assert/strict'), dns=require('node:dns'), net=require('node:net'), cp=require('node:child_process');
    assert.throws(()=>net.connect({host:'127.0.0.1',port:1}),{code:'BENCH_IO_DENIED'});
    assert.throws(()=>net.connect({host:'example.invalid',port:443}),{code:'BENCH_IO_DENIED'});
    assert.throws(()=>cp.execFileSync(process.execPath,['-e','process.exit(0)']),{code:'BENCH_IO_DENIED'});
    assert.equal(typeof new dns.promises.Resolver().resolve4,'function');
    Promise.all([assert.rejects(dns.promises.resolve4('example.invalid'),{code:'BENCH_IO_DENIED'}),
      dns.promises.lookup('::1',{all:true}).then(r=>assert.deepEqual(r,[{address:'::1',family:6}]))]).then(()=>{
      const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{assert(server.address().port>0);server.close(()=>console.log('guard verified'));});
    }).catch(e=>{console.error(e);process.exitCode=1});`;
  const output = execFileSync(process.execPath, ['--require', guard, '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, DATA_DIR: process.env.DATA_DIR, BENCH_RUN_ID: 'guard-fixture', BENCH_ALLOWED_PORTS: '0' } });
  expect(output.trim()).toBe('guard verified');
});
