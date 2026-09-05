// createResponsesLogger is 100% NoCoverage elsewhere: no existing test invokes
// it. Covers the worker-environment early return, normal directory creation +
// logInput/logOutput/flush buffering, the mkdirSync failure path, and the
// writeFileSync failure fallback. fs fully mocked, no real disk I/O.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mkdirSync = vi.fn();
const writeFileSync = vi.fn();
vi.mock('fs', () => ({
  default: { mkdirSync: (...a) => mkdirSync(...a), writeFileSync: (...a) => writeFileSync(...a) },
}));

import { createResponsesLogger } from 'open-sse/transformer/responsesTransformer.js';

beforeEach(() => {
  mkdirSync.mockReset();
  writeFileSync.mockReset();
});

describe('createResponsesLogger', () => {
  it('creates the log directory recursively under the given logsDir with a responses_<model>_ prefix', () => {
    const logger = createResponsesLogger('gpt-x', '/tmp/logs-root');
    expect(logger).not.toBeNull();
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    const [dirArg, opts] = mkdirSync.mock.calls[0];
    expect(dirArg.startsWith('/tmp/logs-root/logs/responses_gpt-x_')).toBe(true);
    expect(opts).toEqual({ recursive: true });
  });

  it('logInput/logOutput buffer events and flush writes both files newline-joined', () => {
    const logger = createResponsesLogger('m', '/tmp/logs-root');
    logger.logInput('in-1');
    logger.logInput('in-2');
    logger.logOutput('out-1');
    logger.flush();
    expect(writeFileSync).toHaveBeenCalledTimes(2);
    const [[inputPath, inputContent], [outputPath, outputContent]] = writeFileSync.mock.calls;
    expect(inputPath.endsWith('1_input_stream.txt')).toBe(true);
    expect(inputContent).toBe('in-1\nin-2');
    expect(outputPath.endsWith('2_output_stream.txt')).toBe(true);
    expect(outputContent).toBe('out-1');
  });

  it('returns null without throwing when mkdirSync throws', () => {
    mkdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    const logger = createResponsesLogger('m', '/tmp/logs-root');
    expect(logger).toBeNull();
  });

  it('flush swallows a writeFileSync failure rather than throwing', () => {
    const logger = createResponsesLogger('m', '/tmp/logs-root');
    writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => logger.flush()).not.toThrow();
  });

  it('returns null in a worker environment where fs.mkdirSync is not a function', async () => {
    vi.resetModules();
    vi.doMock('fs', () => ({ default: {} }));
    const { createResponsesLogger: createLoggerNoFs } =
      await import('open-sse/transformer/responsesTransformer.js');
    expect(createLoggerNoFs('m')).toBeNull();
  });
});
