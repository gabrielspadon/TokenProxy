import { describe, it, expect } from 'vitest';
import { boundedLogRecord, createLogFrameCapture } from '../../open-sse/utils/boundedLogRecord.js';

describe('bounded redaction before retention admission', () => {
  it('omits oversized values without splitting their credentials and never invokes getters', () => {
    let reads = 0;
    const result = boundedLogRecord({ body: 'Bearer ' + 's'.repeat(10000000), password: 'tiny', headers: { authorization: ['secret'] }, get unsafe() { reads++; throw new Error(); } });
    expect(reads).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.body).toBe('[omitted: retention limit]');
    expect(result.password).toBe('[redacted]');
  });
  it('stops traversing large arrays and handles cycles and prototype keys', () => {
    const value = { items: Array.from({ length: 100000 }, (_, index) => index) }; value.self = value;
    const result = boundedLogRecord(value, { maxNodes: 30 });
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    expect({}.polluted).toBeUndefined();
    expect(boundedLogRecord(JSON.parse('{"__proto__":{"polluted":true}}'))).toHaveProperty('__proto__');
  });
  it('redacts JSON secret fields across every possible stream chunk split', () => {
    const line = 'data: {"access_token":"arbitrary-secret","content":"Bearer abcdefghijklmnop"}\n';
    for (let split = 1; split < line.length; split++) {
      const output = [];
      const frame = createLogFrameCapture(v => output.push(v));
      frame.push(line.slice(0, split)); frame.push(line.slice(split)); frame.close();
      expect(output.join('')).not.toMatch(/arbitrary-secret|abcdefghijklmnop/);
      expect(output.join('')).toContain('[redacted]');
    }
  });
  it('omits incomplete, opaque and oversized frames and clears cancellation state', () => {
    const output = [];
    const frame = createLogFrameCapture(v => output.push(v), 64);
    frame.push('Bearer abc'); frame.push('defghijklmnop'); frame.close();
    expect(output).toEqual([]);
    expect(frame.status()).toMatchObject({ pendingChars: 0, omitted: 1, closed: true });
    const large = createLogFrameCapture(v => output.push(v), 64);
    for (let n = 0; n < 10000; n++) large.push('x'.repeat(64));
    expect(large.status().pendingChars).toBeLessThanOrEqual(64);
    large.push('\ndata: [DONE]\n');
    expect(output).toEqual(['data: [DONE]\n']);
  });
});
