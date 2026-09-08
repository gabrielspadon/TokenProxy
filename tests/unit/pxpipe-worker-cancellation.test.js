import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPxpipeWorkerPool } from '../../src/lib/pxpipe/workerPool.mjs';

let pool;
const input = value => ({ body: new TextEncoder().encode(JSON.stringify(value)), model: 'synthetic' });
beforeEach(async () => {
  const directory = join(process.env.DATA_DIR, 'pxpipe-worker-fixture');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'library.mjs');
  await writeFile(entry, `let calls=0; export async function transformAnthropicMessages({body}) {
    const value=JSON.parse(new TextDecoder().decode(body));
    if(value.spin) while(true) {}
    if(value.delay) await new Promise(resolve=>setTimeout(resolve,value.delay));
    return {applied:false,reason:'fixture',body, calls:++calls};
  }`);
  pool = createPxpipeWorkerPool({ entry, maxQueued: 2, maxBytes: 1024 * 1024 });
});
afterEach(async () => { await pool?.close(); });

describe('PXPIPE owned worker lifecycle', () => {
  it('reuses the worker and leaves caller bytes intact', async () => {
    const request = input({ marker: 'retained' }), before = Uint8Array.from(request.body);
    expect((await pool.run(request)).calls).toBe(1);
    expect((await pool.run(input({ marker: 'next' }))).calls).toBe(2);
    expect(request.body).toEqual(before);
  });
  it('terminates active CPU work on cancellation then recovers without overlapping workers', async () => {
    await pool.run(input({ warmup: true }));
    const caller = new AbortController();
    const work = pool.run({ ...input({ spin: true }), signal: caller.signal });
    const outcome = work.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 20));
    const started = performance.now(); caller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(performance.now() - started).toBeLessThan(500);
    expect((await pool.run(input({ recovered: true }))).calls).toBe(1);
  });
  it('removes cancelled queued work without dispatching it', async () => {
    const first = pool.run(input({ delay: 40 })), caller = new AbortController();
    const second = pool.run({ ...input({ spin: true }), signal: caller.signal });
    const outcome = second.catch(error => error); caller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect((await first).calls).toBe(1);
    expect((await pool.run(input({ next: true }))).calls).toBe(2);
  });
  it('bounds distinct queued jobs and rejects excess payload before dispatch', async () => {
    const first = pool.run(input({ delay: 40 }));
    const second = pool.run(input({ second: true })), third = pool.run(input({ third: true }));
    await expect(pool.run(input({ fourth: true }))).rejects.toMatchObject({ code: 'pxpipe_worker_busy' });
    await Promise.all([first, second, third]);
    await expect(pool.run({ body: new Uint8Array(1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'pxpipe_worker_capacity' });
  });
  it('terminates timed-out CPU work and refuses post-close admission', async () => {
    await pool.run(input({ warmup: true }));
    await expect(pool.run({ ...input({ spin: true }), timeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await pool.run(input({ recovered: true }))).calls).toBe(1);
    await pool.close();
    await expect(pool.run(input({ next: true }))).rejects.toMatchObject({ code: 'pxpipe_worker_closed' });
  });
});
