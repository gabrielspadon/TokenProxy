import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const MODEL_ENCODINGS = new Map([
  ...['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-mini',
    'gpt-4o-mini-2024-07-18', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-5', 'o1', 'o3', 'o4-mini'].map(model => [model, 'o200k_base']),
  ...['gpt-4', 'gpt-4-0613', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0125',
    'text-embedding-3-small', 'text-embedding-3-large'].map(model => [model, 'cl100k_base']),
]);
export const TOKENIZER_LIMITS = Object.freeze({ inputBytes: 131072, items: 8192, requests: 16, queuedBytes: 524288, timeoutMs: 10000 });
export const encodingForModel = model => MODEL_ENCODINGS.get(model) || null;
const failure = (message, code) => Object.assign(new Error(message), { code });

// Model mapping is deliberately finite. Routed aliases and unknown models have
// no verified encoding. Text BPE counts do not include provider message framing.
export function createLocalTokenizer({ workerFactory = options => new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  const encodings = new Map();
  parentPort.on('message', ({ id, encoding, texts }) => {
    try {
      let api = encodings.get(encoding);
      if (!api) { api = require(workerData.paths[encoding]); api.setMergeCacheSize(0); encodings.set(encoding, api); }
      const counts = texts.map(text => api.countTokens(text, { disallowedSpecial: new Set() }));
      parentPort.postMessage({ id, counts });
    } catch { parentPort.postMessage({ id, error: 'Tokenization failed' }); }
  });
`, { eval: true, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')), ...options }) } = {}) {
  let worker, active, stopping, closed = false, bytes = 0, sequence = 0, peakBytes = 0;
  const queue = [];
  function stopWorker() {
    const old = worker; worker = undefined;
    if (old) stopping = Promise.resolve(old.terminate()).catch(() => {}).finally(() => { stopping = undefined; pump(); });
  }
  function settle(job, error, counts) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    bytes -= job.bytes;
    if (active === job) active = undefined;
    else { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); }
    job.texts = undefined;
    if (error) job.reject(error);
    else job.resolve({ tokens: counts.reduce((sum, count) => sum + count, 0), counts, encoding: job.encoding,
      tokenizer: 'gpt-tokenizer@4.0.0', scope: 'text_only', estimated: false });
    pump();
  }
  function pump() {
    if (active || closed || stopping) return;
    if (!queue.length) { worker?.unref(); return; }
    active = queue.shift();
    try {
      if (!worker) {
        worker = workerFactory({ resourceLimits: { maxOldGenerationSizeMb: 192 }, workerData: { paths: {
          o200k_base: require.resolve('gpt-tokenizer/cjs/encoding/o200k_base'),
          cl100k_base: require.resolve('gpt-tokenizer/cjs/encoding/cl100k_base'),
        } } });
        const current = worker;
        worker.on('message', result => {
          if (current !== worker || result.id !== active?.id) return;
          settle(active, result.error ? failure(result.error, 'tokenizer_failed') : null, result.counts);
        });
        const failed = () => {
          if (current !== worker) return;
          const job = active; stopWorker();
          if (job) settle(job, failure('Tokenizer worker stopped', 'tokenizer_failed'));
        };
        worker.on('error', failed);
        worker.on('exit', failed);
      }
      worker.ref();
      worker.postMessage({ id: active.id, encoding: active.encoding, texts: active.texts });
    } catch { const job = active; stopWorker(); settle(job, failure('Tokenizer unavailable', 'tokenizer_failed')); }
  }
  return {
    count(texts, { model, encoding = encodingForModel(model), signal, timeoutMs = TOKENIZER_LIMITS.timeoutMs } = {}) {
      if (closed) return Promise.reject(failure('Tokenizer is closed', 'tokenizer_closed'));
      if (!['o200k_base', 'cl100k_base'].includes(encoding)) return Promise.reject(failure('Model encoding is unverified', 'unsupported_model'));
      if (!Array.isArray(texts) || texts.length > TOKENIZER_LIMITS.items || texts.some(text => typeof text !== 'string')) return Promise.reject(failure('Invalid text input', 'invalid_input'));
      let size = 0;
      for (const text of texts) {
        if (text.length > TOKENIZER_LIMITS.inputBytes || (size += Buffer.byteLength(text)) > TOKENIZER_LIMITS.inputBytes) return Promise.reject(failure('Tokenizer text exceeds 128 KiB', 'input_too_large'));
      }
      if (signal?.aborted) return Promise.reject(failure('Tokenization cancelled', 'aborted'));
      if (queue.length + Number(Boolean(active)) >= TOKENIZER_LIMITS.requests || bytes + size > TOKENIZER_LIMITS.queuedBytes) return Promise.reject(failure('Tokenizer capacity exhausted', 'overloaded'));
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, texts: [...texts], bytes: size, encoding, signal, resolve, reject };
        const cancel = code => { if (active === job) stopWorker(); settle(job, failure('Tokenization cancelled', code)); };
        job.abort = () => cancel('aborted');
        job.timer = setTimeout(() => cancel('timeout'), Math.max(1, Math.min(TOKENIZER_LIMITS.timeoutMs, Number(timeoutMs) || TOKENIZER_LIMITS.timeoutMs)));
        signal?.addEventListener('abort', job.abort, { once: true });
        bytes += size; peakBytes = Math.max(bytes, peakBytes); queue.push(job); pump();
      });
    },
    status: () => ({ requests: queue.length + Number(Boolean(active)), bytes, peakBytes, closed }),
    close() {
      closed = true; stopWorker();
      for (const job of [active, ...queue].filter(Boolean)) settle(job, failure('Tokenizer is closed', 'tokenizer_closed'));
    },
  };
}
export const localTokenizer = createLocalTokenizer();
