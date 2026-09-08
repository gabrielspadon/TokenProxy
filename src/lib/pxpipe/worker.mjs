import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { transformAnthropicMessages } = await import(pathToFileURL(workerData.entry).href);
if (typeof transformAnthropicMessages !== 'function') throw new Error('PXPIPE transform unavailable');
parentPort.on('message', async ({ id, input }) => {
  try {
    const result = await transformAnthropicMessages(input);
    if (result?.body instanceof Uint8Array) {
      if (result.body.byteLength > 64 * 1024 * 1024) throw new Error('PXPIPE result exceeds capacity');
      const body = Uint8Array.from(result.body);
      parentPort.postMessage({ id, result: { ...result, body } }, [body.buffer]);
    } else parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, error: true });
  }
});
