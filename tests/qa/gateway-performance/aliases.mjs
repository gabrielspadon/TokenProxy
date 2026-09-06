import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.conditions?.includes('require')) return nextResolve(specifier, context);
  if (specifier === 'node-machine-id') return nextResolve(new URL('./machine-id.mjs', import.meta.url).href, context);
  let candidate;
  if (specifier.startsWith('@/')) candidate = resolve(root, 'src', specifier.slice(2));
  else if (specifier.startsWith('open-sse/')) candidate = resolve(root, specifier);
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) candidate = fileURLToPath(new URL(specifier, context.parentURL));
  if (candidate) {
    for (const suffix of ['', '.js', '/index.js']) {
      if (existsSync(candidate + suffix) && (suffix || /\.(?:js|mjs|json|node)$/.test(candidate))) return nextResolve(pathToFileURL(candidate + suffix).href, context);
    }
  }
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier === 'next/headers') return nextResolve('next/headers.js', context);
  return nextResolve(specifier, context);
} });
