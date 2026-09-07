'use strict';
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// The dev overlay's npm update check is advisory and otherwise runs on prepare.
// Keep its installed version honest while leaving freshness explicitly unknown.
const versionInfoPath = require.resolve('next/dist/server/dev/hot-reloader-shared-utils');
const versionInfo = require(versionInfoPath);
require.cache[versionInfoPath].exports = { ...versionInfo, getVersionInfo: async () => ({ installed: require('next/package.json').version, staleness: 'unknown' }) };
const next = require('next');

async function main() {
  if (process.env.TOKENPROXY_PREVIEW_ISOLATED !== '1' || !global.__tokenproxyPreviewGuard) throw new Error('Dev preview requires the isolated preload');
  const project = path.resolve(__dirname, '../../..');
  const root = process.env.TOKENPROXY_REDESIGN_ROOT;
  if (path.resolve(project, process.env.NEXT_DIST_DIR || '') !== path.join(root, 'next-dev')) throw new Error('Dev build output must stay inside the owned runtime');
  const port = Number(process.env.PORT);
  const config = (await import(pathToFileURL(path.join(project, 'next.config.mjs')).href)).default;
  // Next's custom-server prepare path reloads the cached config module and
  // ignores the constructor's conf option. Change only this process's object.
  config.experimental = { ...config.experimental, workerThreads: true };
  const app = next({ dev: true, webpack: true, dir: project, hostname: '127.0.0.1', port });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = http.createServer((request, response) => handler(request, response).catch(error => {
    console.error('Isolated dev request failed', error.code || error.name);
    if (!response.headersSent) response.writeHead(500);
    response.end('Isolated preview request failed');
  }));
  server.on('upgrade', app.getUpgradeHandler());
  server.listen(port, '127.0.0.1');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
