import fs from 'node:fs/promises';
import path from 'node:path';
import { maskSensitiveHeaders, isSensitiveHeaderName, redactSecretsText } from './redact.js';
import { boundedLogRecord, createLogFrameCapture } from './boundedLogRecord.js';
import { createBoundedLogSink } from './boundedLogSink.js';
import { registerShutdownFlusher } from '../../src/lib/shutdown.js';

const SESSION_BYTES = 256 * 1024;
const SESSION_SLOTS = 64;
const generations = new Map();
let sequence = 0;
const sink = createBoundedLogSink({ async write(item) {
  if (generations.get(item.slot) !== item.generation) return false;
  if (item.begin) {
    await fs.mkdir(path.dirname(item.sessionPath), { recursive: true, mode: 0o700 });
    await fs.rm(item.sessionPath, { recursive: true, force: true });
    await fs.mkdir(item.sessionPath, { mode: 0o700 });
  } else {
    await fs[item.filename.endsWith('.json') ? 'writeFile' : 'appendFile'](path.join(item.sessionPath, item.filename), item.text, { mode: 0o600 });
  }
} });
registerShutdownFlusher(() => sink.close(), 0);

const methods = ['logClientRawRequest', 'logRawRequest', 'logOpenAIRequest', 'logTargetRequest', 'logProviderResponse', 'appendProviderChunk', 'appendOpenAIChunk', 'logConvertedResponse', 'appendConvertedChunk', 'logError'];
function noop() {
  return { sessionPath: null, ...Object.fromEntries(methods.map(name => [name, () => {}])), close: async () => {}, cancel() {}, flush: () => Promise.resolve(), status: () => ({ enabled: false }) };
}

/** Opt-in bounded content retention. Completion never waits for disk on the response path. */
export async function createRequestLogger(sourceFormat, targetFormat, model, { signal } = {}) {
  if (typeof process === 'undefined' || process.env.ENABLE_REQUEST_LOGS !== 'true' || signal?.aborted) return noop();
  const generation = ++sequence;
  const slot = generation % SESSION_SLOTS;
  const sessionPath = path.join(process.cwd(), 'logs', 'requests-v2', `session-${slot}`);
  generations.set(slot, generation);
  let closed = false;
  let completion = null;
  let bytes = 0;
  let dropped = 0;
  const frames = [];
  if (!sink.enqueue({ begin: true, sessionPath, slot, generation }, 256, { protected: true })) return noop();
  function append(filename, text) {
    if (closed || generations.get(slot) !== generation) return false;
    const size = Buffer.byteLength(text);
    if (size > SESSION_BYTES - (filename === 'retention.json' ? 0 : 2048) - bytes) { dropped++; return false; }
    if (!sink.enqueue({ sessionPath, slot, generation, filename, text }, size + 256, { evictPending: filename === 'retention.json', protected: filename === 'retention.json' })) { dropped++; return false; }
    bytes += size;
    return true;
  }
  function record(filename, value) {
    if (closed) return;
    try {
    const { headers, ...rest } = value;
    const safe = boundedLogRecord(rest);
    if (headers !== undefined) {
      const plain = {};
      if (headers && typeof headers.entries === 'function') {
        let count = 0;
        for (const [key, value] of headers.entries()) { if (++count > 64) break; Object.defineProperty(plain, key, { value, enumerable: true }); }
      } else if (headers && typeof headers === 'object') {
        let count = 0;
        for (const key in headers) { if (++count > 64) break; const descriptor = Object.getOwnPropertyDescriptor(headers, key); if (descriptor && 'value' in descriptor) Object.defineProperty(plain, key, { value: descriptor.value, enumerable: true }); }
      }
      // Bound header enumeration before masking, while preserving the documented credential tail.
      const bounded = {};
      let count = 0;
      let headerBytes = 4096;
      for (const key in plain || {}) {
        if (++count > 64) break;
        const v = plain[key];
        if (key.length > 128) continue;
        const value = typeof v === 'string' && v.length <= 1024 ? v : '[omitted]';
        const size = Buffer.byteLength(key) + Buffer.byteLength(value);
        if (size > headerBytes) break;
        headerBytes -= size;
        Object.defineProperty(bounded, key, { enumerable: true, value: isSensitiveHeaderName(key) ? value : redactSecretsText(value) });
      }
      safe.headers = maskSensitiveHeaders(bounded);
    }
    let text = JSON.stringify({ timestamp: new Date().toISOString(), ...safe }) + '\n';
    if (Buffer.byteLength(text) > 32768) text = JSON.stringify({ _truncated: true, reason: 'record-byte-limit' }) + '\n';
    append(filename, text);
    } catch { dropped++; }
  }
  function frame(filename) {
    const capture = createLogFrameCapture(text => append(filename, text));
    frames.push(capture);
    return chunk => { if (!closed) capture.push(chunk); };
  }
  function finish(outcome = 'complete') {
    if (closed) return;
    for (const capture of frames) capture.close();
    record('retention.json', { outcome, bytes, dropped, frameOmissions: frames.reduce((sum, capture) => sum + capture.status().omitted, 0), limitBytes: SESSION_BYTES });
    closed = true;
    signal?.removeEventListener('abort', cancel);
  }
  function cancel() { finish('cancelled'); }
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  record('session.json', { sourceFormat, targetFormat, model, generation });
  return {
    sessionPath,
    logClientRawRequest: (endpoint, body, headers = {}) => record('1_req_client.json', { endpoint, body, headers }),
    logRawRequest: (body, headers = {}) => record('2_req_source.json', { body, headers }),
    logOpenAIRequest: body => record('3_req_openai.json', { body }),
    logTargetRequest: (url, headers, body) => record('4_req_target.json', { url, headers, body }),
    logProviderResponse: (status, statusText, headers, body) => record('5_res_provider.json', { status, statusText, headers, body }),
    appendProviderChunk: frame('5_res_provider.txt'),
    appendOpenAIChunk: frame('6_res_openai.txt'),
    appendConvertedChunk: frame('7_res_client.txt'),
    logConvertedResponse: body => record('7_res_client.json', { body }),
    logError: (error, requestBody = null) => record('6_error.json', { error: error?.message || String(error), stack: error?.stack, requestBody }),
    cancel,
    close() { finish(); return completion ??= sink.flush(); },
    flush: () => sink.flush(),
    status: () => ({ enabled: true, closed, bytes, dropped, queue: sink.status(), frames: frames.map(capture => capture.status()) }),
  };
}

// Named legacy imports remain supported. Error records use the same bounded retention path.
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  void createRequestLogger(provider, 'error', model).then(logger => { logger.logTargetRequest(url, {}, requestBody); logger.logError(error); return logger.close(); }).catch(() => {});
}
export const __requestLog = { flush: () => sink.flush(), status: () => sink.status(), SESSION_BYTES, SESSION_SLOTS };
