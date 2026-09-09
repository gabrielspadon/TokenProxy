import { mkdir, writeFile, readdir, readFile, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eventEndpoint } from './claudeAdapter.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BYTES = 16384;
const FIELDS = new Set(['eventId', 'occurredAt', 'type', 'clientId', 'clientSessionId', 'taskId', 'projectId', 'targetClientId', 'targetTaskId', 'outcome', 'beforeTokens', 'afterTokens', 'tokenMeasurementMethod', 'requestId', 'logicalRequestId', 'sessionId']);
export function compactEvent(input, { clientId, taskId, projectId, eventId = randomUUID(), occurredAt = new Date().toISOString() } = {}) {
  if (input?.hook_event_name !== 'PostCompact' || !['manual', 'auto'].includes(input.trigger) || typeof input.session_id !== 'string' || !input.session_id || !UUID.test(eventId)) throw new Error('An actual PostCompact notification and exact client session are required');
  if (typeof clientId !== 'string' || !clientId.trim()) throw new Error('An explicit client identity is required');
  // Native 2.1.263 invokes PostCompact before persisting the new boundary and
  // before every path assigns postTokens. Its hook input contains no counts.
  // The notification proves client completion, without transcript inference.
  const event = { eventId, occurredAt, type: 'compaction', clientId, clientSessionId: input.session_id };
  if (taskId) event.taskId = taskId;
  if (projectId) event.projectId = projectId;
  return event;
}
export async function sendClientEvent(event, { baseUrl, apiKey, signal, fetchImpl = fetch, outboxDir } = {}) {
  const endpoint = eventEndpoint(baseUrl), body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_BYTES || !UUID.test(event?.eventId) || Object.keys(event).some(key => !FIELDS.has(key))) throw new Error('Event requires allowed evidence fields, a UUID and at most 16 KiB');
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw new Error('TOKENPROXY_API_KEY is required');
  signal?.throwIfAborted();
  let retainedPath;
  if (outboxDir) {
    await mkdir(outboxDir, { recursive: true, mode: 0o700 });
    // A content-addressed file preserves an identical retry without permitting
    // a changed payload to overwrite the original evidence for an event ID.
    retainedPath = join(outboxDir, `${event.eventId}-${createHash('sha256').update(body).digest('hex')}.json`);
    const lock = join(outboxDir, '.admission');
    try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Event outbox is busy or interrupted; inspect it before retrying'); }
    try {
      const files = (await readdir(outboxDir)).filter(name => name !== '.admission');
      if (files.length >= 256 && !files.includes(retainedPath.split('/').at(-1))) throw new Error('Event outbox is full; archive acknowledged evidence before continuing');
      try { await writeFile(retainedPath, body, { mode: 0o600, flag: 'wx' }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readFile(retainedPath, 'utf8') !== body) throw new Error('Retained event is incomplete or changed; inspect it before retrying');
      }
    } finally { await rmdir(lock); }
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500);
  // An uncertain event may be explicitly retried using its retained exact
  // payload. This adapter has no generation endpoint and never auto-retries.
  const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body, signal: requestSignal });
  const reader = response.body?.getReader(), chunks = []; let bytes = 0;
  if (!reader) throw new Error('Gateway returned no event evidence');
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 65536) { await reader.cancel(); throw new Error('Gateway event response exceeds the bound'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let result; try { result = JSON.parse(text); } catch { throw new Error('Gateway returned invalid event evidence'); }
  if (!response.ok) throw new Error(`Gateway refused event with HTTP ${response.status}`);
  if (![200, 201].includes(response.status) || result.event?.clientEventId !== event.eventId.toLowerCase() || typeof result.duplicate !== 'boolean') throw new Error('Gateway did not acknowledge the exact event identity');
  return { eventId: event.eventId, retainedId: result.event.id, duplicate: result.duplicate, status: response.status, retainedPath };
}
