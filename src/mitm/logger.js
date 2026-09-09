const path = require('node:path');
const fs = require('node:fs/promises');
const { DATA_DIR } = require('./paths');
const { LOG_BLACKLIST_URL_PARTS } = require('./config');

// Development mode alone is not consent to retain intercepted conversation content.
const enabled = () => process.env.ENABLE_REQUEST_LOGS === 'true';
let helpers = null;
let sequence = 0;
const ready = Promise.all([
  import('../../open-sse/utils/boundedLogSink.js'),
  import('../../open-sse/utils/boundedLogRecord.js'),
  import('../lib/shutdown.js'),
  import('../../open-sse/utils/asyncLogOutput.js'),
]).then(([queue, records, shutdown, output]) => {
  const sink = queue.createBoundedLogSink({ async write({ file, text }) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, text, { mode: 0o600 });
    await fs.chmod(file, 0o600);
  } });
  shutdown.registerShutdownFlusher(() => sink.close(), 0);
  helpers = { ...records, ...output, sink };
}).catch(() => {});
const log = msg => helpers?.logOutput(typeof msg === 'string' && msg.length <= 4096 ? `[MITM] ${msg}` : '[MITM] omitted');
const err = msg => helpers?.logOutput(typeof msg === 'string' && msg.length <= 4096 ? `[MITM] ${msg}` : '[MITM] omitted', 2);
const allowed = req => enabled() && helpers && !LOG_BLACKLIST_URL_PARTS.some(part => (req.url || '').includes(part));
function save(record) {
  const file = path.join(DATA_DIR, 'logs', 'mitm-v2', `record-${sequence++ % 128}.json`);
  let safe = JSON.stringify(helpers.boundedLogRecord(record));
  if (Buffer.byteLength(safe) > 32768) safe = JSON.stringify({ omitted: true, reason: 'record-byte-limit' });
  return helpers.sink.enqueue({ file, text: safe }, Buffer.byteLength(safe) + 256) ? file : null;
}
function dumpRequest(req, bodyBuffer, tag = 'raw') {
  if (!allowed(req)) return null;
  let body = { omitted: true, reason: 'non-json-or-limit', bytes: bodyBuffer?.length || 0 };
  if (bodyBuffer?.length <= 8192) { try { body = JSON.parse(bodyBuffer.toString('utf8')); } catch { /* opaque content is not retained */ } }
  return save({ tag, method: req.method, url: req.url, headers: req.headers, body });
}
function createResponseDumper(req, tag = 'raw') {
  if (!allowed(req)) return null;
  const metadata = helpers.boundedLogRecord({ tag, url: req.url });
  let bytes = 0;
  let closed = false;
  return {
    file: null,
    writeHeader(status, headers) { if (!closed) Object.assign(metadata, helpers.boundedLogRecord({ status, headers })); },
    writeChunk(chunk) { if (!closed) bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.byteLength || 0; },
    end() { if (closed) return; closed = true; this.file = save({ ...metadata, body: { omitted: true, reason: 'stream-content-not-captured', bytes } }); },
    cancel() { closed = true; },
  };
}
// Compatibility entrypoint. The bounded v2 ring replaces destructive startup clearing.
function clearDumpDir() {}
module.exports = { log, err, dumpRequest, createResponseDumper, clearDumpDir, flush: async () => { await ready; return helpers?.sink.flush(); }, ready };
