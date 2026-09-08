import { isSecretBodyKey, isSensitiveHeaderName, redactSecretsText } from './redact.js';

const OMITTED = '[omitted: retention limit]';
/** Bounds traversal BEFORE inspecting strings or enumerating arbitrarily large containers. */
export function boundedLogRecord(value, { maxBytes = 16384, maxNodes = 512, maxDepth = 12 } = {}) {
  let remaining = Number.isFinite(maxBytes) ? Math.max(128, Math.min(262144, maxBytes)) : 16384;
  let nodes = 0;
  let truncated = false;
  const omit = () => { truncated = true; return OMITTED; };
  const seen = new WeakSet();
  function walk(v, depth, headers = false) {
    if (++nodes > maxNodes || depth > maxDepth || remaining < 64) return omit();
    remaining -= 16;
    if (typeof v === 'string') {
      // Do not slice unknown raw text: the cut could bisect an otherwise recognizable credential.
      if (v.length * 3 > remaining) return omit();
      remaining -= v.length * 3;
      return redactSecretsText(v);
    }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (!v || typeof v !== 'object') return null;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    const out = Array.isArray(v) ? [] : {};
    // for-in permits an early stop; Object.entries would allocate the entire container.
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (nodes >= maxNodes || remaining < 64) { if (Array.isArray(out)) out.push(omit()); else { truncated = true; out._truncated = true; } break; }
      if (key.length > 128) { truncated = true; out._truncated = true; break; }
      remaining -= key.length * 3;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      const targetKey = Array.isArray(out) ? out.length : key;
      Object.defineProperty(out, targetKey, { enumerable: true, configurable: true, writable: true, value:
        (isSecretBodyKey(key) || (headers && isSensitiveHeaderName(key))) ? '[redacted]' :
          (!descriptor || !('value' in descriptor)) ? '[omitted: accessor]' : walk(descriptor.value, depth + 1, key.toLowerCase() === 'headers') });
      if (!Array.isArray(out) && (out[targetKey] === OMITTED || out[targetKey]?._truncated === true)) out._truncated = true;
    }
    return out;
  }
  try { const result = walk(value, 0); if (truncated && result && typeof result === "object" && !Array.isArray(result)) result._truncated = true; return result; } catch { return { redacted: true, reason: 'redaction failed' }; }
}

/** Only complete bounded SSE lines can be retained. Incomplete/oversize frames are omitted. */
export function createLogFrameCapture(emit, maxChars = 8192) {
  let pending = '';
  let discarding = false;
  let closed = false;
  let omitted = 0;
  function push(chunk) {
    if (closed || typeof chunk !== 'string') return;
    // A giant chunk is omitted outright, including its trailing partial line.
    if (chunk.length > maxChars) { pending = ''; discarding = true; omitted++; return; }
    for (const part of chunk.split(/(?<=\n)/)) {
      if (discarding) { if (part.endsWith('\n')) discarding = false; continue; }
      if (pending.length + part.length > maxChars) { pending = ''; discarding = !part.endsWith('\n'); omitted++; continue; }
      pending += part;
      if (pending.endsWith('\n')) {
        const line = pending; pending = '';
        const prefix = line.startsWith('data:') ? 'data: ' : '';
        const body = prefix ? line.slice(5).trim() : line.trim();
        if (body === '[DONE]') emit('data: [DONE]\n');
        else {
          try { emit(prefix + JSON.stringify(boundedLogRecord(JSON.parse(body))) + '\n'); }
          catch { omitted++; } // Opaque text cannot be key-redacted safely across frames.
        }
      }
    }
  }
  return { push, close() { closed = true; if (pending || discarding) omitted++; pending = ''; }, status: () => ({ pendingChars: pending.length, omitted, closed }) };
}
