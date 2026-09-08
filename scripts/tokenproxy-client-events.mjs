#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { compactEvent, sendClientEvent } from '../src/lib/clientSetup/events.mjs';

try {
  const mode = process.argv[2];
  if (!['hook', 'send'].includes(mode)) throw new Error('Usage: tokenproxy-client-events.mjs hook | send <exact-event.json>');
  let event;
  if (mode === 'hook') {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1048576) throw new Error('Hook input exceeds 1 MiB'); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid native hook JSON'); }
    if (input.hook_event_name !== 'PostCompact') {
      process.stderr.write(JSON.stringify({ adapter: 'claude-postcompact-v1', observedHook: input.hook_event_name, emitted: false }) + '\n');
      process.exit(0);
    }
    event = compactEvent(input, { clientId: process.env.TOKENPROXY_CLIENT_ID, taskId: process.env.TOKENPROXY_TASK_ID, projectId: process.env.TOKENPROXY_PROJECT_ID });
  } else {
    const file = process.argv[3];
    if (!file) throw new Error('Pass the retained exact event file');
    const handle = await open(file, 'r');
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Event must be a regular file');
      const buffer = Buffer.alloc(16385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) throw new Error('Event exceeds 16 KiB');
      try { event = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { throw new Error('Invalid event JSON'); }
    } finally { await handle.close(); }
  }
  const result = await sendClientEvent(event, { baseUrl: process.env.TOKENPROXY_BASE_URL, apiKey: process.env.TOKENPROXY_API_KEY, outboxDir: process.env.TOKENPROXY_EVENT_OUTBOX || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'tokenproxy-event-outbox') });
  (mode === 'hook' ? process.stderr : process.stdout).write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(`TokenProxy client event not acknowledged: ${error.message}\n`);
  process.exitCode = 1;
}
