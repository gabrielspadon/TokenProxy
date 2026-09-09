import { write, fstat } from 'node:fs';
import { createBoundedLogSink } from './boundedLogSink.js';
import { boundedLogRecord } from './boundedLogRecord.js';
import { registerShutdownFlusher } from '../../src/lib/shutdown.js';

const descriptorKinds = new Map();
const guardedStreams = new WeakSet();
function isPipe(fd) {
  if (!descriptorKinds.has(fd)) descriptorKinds.set(fd, new Promise((resolve, reject) => {
    fstat(fd, (error, stat) => error ? reject(error) : resolve(stat.isFIFO() || stat.isSocket()));
  }));
  return descriptorKinds.get(fd);
}
const output = createBoundedLogSink({ maxRecords: 1024, maxBytes: 1024 * 1024, async write({ fd, text }) {
  if (await isPipe(fd)) {
    // Pipe writes must use libuv's nonblocking stream path. A thread-pool fs.write
    // to a full blocking pipe cannot be cancelled, even during process shutdown.
    const stream = fd === 2 ? process.stderr : process.stdout;
    if (!guardedStreams.has(stream)) { guardedStreams.add(stream); stream.on('error', () => {}); }
    return new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
  }
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(text);
    let offset = 0;
    const next = () => write(fd, buffer, offset, buffer.length - offset, null, (error, bytes) => {
      if (error) return reject(error);
      if (!bytes) return reject(new Error('zero-byte diagnostic write'));
      offset += bytes;
      if (offset < buffer.length) next(); else resolve();
    });
    next();
  });
} });

registerShutdownFlusher(() => output.close(), 0);
export function logOutput(message, fd = 1) {
  const safe = boundedLogRecord(message, { maxBytes: 16384 });
  const text = (typeof safe === 'string' ? safe : JSON.stringify(safe)) + '\n';
  return output.enqueue({ fd: fd === 2 ? 2 : 1, text }, Buffer.byteLength(text) + 32);
}
export const flushLogOutput = () => output.flush();
export const logOutputStatus = () => output.status();
