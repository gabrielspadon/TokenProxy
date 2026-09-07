import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __setContextStatusDirForTest, readAllContextStatuses, readContextStatus } from '../../open-sse/handlers/chatCore/contextStatusStore.js';
import { GET } from '../../src/app/api/context-status/route.js';

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-strict-read-'));
  __setContextStatusDirForTest(dir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  __setContextStatusDirForTest(null);
  await fs.rm(dir, { recursive: true, force: true });
});
it('serves a missing telemetry file as an empty successful observation', async () => {
  expect(await readAllContextStatuses({ strict: true })).toEqual([]);
  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).entries).toEqual([]);
});
it('serves valid retained estimates and observed tokens through the actual strict route', async () => {
  await fs.writeFile(path.join(dir, 'context-status.json'), JSON.stringify({ v: 1, entries: [{ sid: 'abcd1234', ctxTokens: 100, ctxTokensActual: 83, saveBytes: -17 }] }));
  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).entries).toEqual([expect.objectContaining({ sid: 'abcd1234', ctxTokens: 100, ctxTokensActual: 83, saveBytes: -17 })]);
});
it.each(['{broken', '{"entries":null}'])('exposes a corrupt operator read without changing best-effort callers for %s', async contents => {
  await fs.writeFile(path.join(dir, 'context-status.json'), contents);
  await expect(readAllContextStatuses({ strict: true })).rejects.toMatchObject({ name: 'ContextStatusReadError', code: 'context_status_corrupt' });
  const response = await GET();
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'context status unavailable' });
  expect(await readAllContextStatuses()).toEqual([]);
  expect(await readContextStatus('abcd1234')).toBeNull();
});
it('propagates an I/O failure to operators while retaining best-effort request reads', async () => {
  vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }));
  await expect(readAllContextStatuses({ strict: true })).rejects.toMatchObject({ name: 'ContextStatusReadError', code: 'context_status_read_failed' });
  const response = await GET();
  expect(response.status).toBe(503);
  expect((await response.json()).entries).toBeUndefined();
  expect(await readAllContextStatuses()).toEqual([]);
  expect(await readContextStatus('abcd1234')).toBeNull();
});
