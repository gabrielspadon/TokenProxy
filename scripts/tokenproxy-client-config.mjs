#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeClientSettings } from '../src/lib/clientSetup/claudeAdapter.mjs';

try {
  const [source, destination, baseUrl, clientId, window, model, contextTokens, capabilityContextTokens] = process.argv.slice(2);
  if (process.argv.length > 10 || !source || !destination || !baseUrl || !clientId || resolve(source) === resolve(destination)) throw new Error('Usage: tokenproxy-client-config.mjs <existing-settings.json> <new-output.json> <gateway-origin> <client-id> [autoCompactWindow [exact-model gateway-context-tokens capability-context-tokens]]');
  const current = JSON.parse(await readFile(source, 'utf8'));
  const settings = claudeClientSettings(current, { nodePath: process.execPath, scriptPath: join(dirname(fileURLToPath(import.meta.url)), 'tokenproxy-client-events.mjs'), baseUrl, clientId, ...(window === undefined ? {} : { autoCompactWindow: Number(window) }), ...(model === undefined ? {} : { model, contextTokens: Number(contextTokens), capabilityContextTokens: Number(capabilityContextTokens) }) });
  await writeFile(destination, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created opt-in settings. Supply TOKENPROXY_API_KEY in the client environment and review the output before passing it to claude --settings. Native output and compaction reserves remain.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
