import assert from 'node:assert/strict';
import { createSseDecoder } from '../../open-sse/utils/sseDecoder.js';
if (!process.env.DATA_DIR) throw new Error('Explicit scratch DATA_DIR required');
const encoder = new TextEncoder();
const payload = { text: 'José 🐋', arguments: '{"n":9007199254740993}', signed: 'opaque-Σ' };
const wire = '\uFEFF: keepalive\r\nid: ignored\r\nretry: 123\r\n\r\nid: retained\r\nevent: sample\r\ndata: {"text":"José 🐋",\r\ndata: "arguments":"{\\"n\\":9007199254740993}","signed":"opaque-Σ"}\r\n\r\ndata: [DONE]\r\n\r\n';
let checked = 0;
for (let size = 1; size <= 128; size++) {
  const events = []; const decoder = createSseDecoder(event => events.push(event));
  const bytes = encoder.encode(wire);
  for (let at = 0; at < bytes.length; at += size) decoder.feed(bytes.subarray(at, at + size));
  decoder.finish(); decoder.release();
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'sample'); assert.equal(events[0].id, 'retained');
  assert.deepEqual(JSON.parse(events[0].data), payload); assert.equal(events[1].data, '[DONE]');
  decoder.feed(encoder.encode('data: ignored\n\n')); assert.equal(events.length, 2); checked++;
}
console.log(JSON.stringify({ node: process.version, architecture: process.arch, fragmentSizesChecked: checked, package: 'eventsource-parser', version: '3.1.1', result: 'passed', scope: 'actual shared decoder and dependency, not a whole application build' }));
