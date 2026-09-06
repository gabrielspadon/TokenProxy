const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');

const origCreate = http.createServer.bind(http);

// Undici 7 requires Node >=20.18.1, above Next 16's >=20.9.0 requirement.
// Refuse unsupported transport runtimes at boot rather than during a request.
// Kept in step with package.json and cli/package.json.
const MIN_NODE_VERSION = '20.18.1';

function nodeBelowMinimum(current, minimum) {
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = parse(current);
  const [x, y, z] = parse(minimum);
  return a !== x ? a < x : b !== y ? b < y : c < z;
}

if (nodeBelowMinimum(process.versions.node, MIN_NODE_VERSION)) {
  console.error(
    `[tokenproxy] Node ${process.versions.node} is not supported. Install Node ${MIN_NODE_VERSION} or newer and start again.`
  );
  process.exit(1);
}

// A launcher that redirects stdout/stderr to a pipe and never reads it freezes
// the whole server: the pipe buffer fills, the write stops draining, and every
// HTTP request times out while the port stays LISTENING. The process is alive
// and unrecoverable, which is what makes it so hard to diagnose (#2447).
//
// Console output is not worth a hung gateway, so drop it once a stream has more
// than this queued. A TTY and a file both drain on their own and are left alone;
// only a pipe can wedge this way. Guarding here covers every caller at once,
// since console.log is the one chokepoint the server's logging routes through.
const LOG_BACKPRESSURE_BYTES = Number(process.env.LOG_BACKPRESSURE_BYTES || 1 << 20);

function guardStreamBackpressure(stream, label) {
  // isTTY covers the console; a file stream reports neither, and only a pipe
  // both lacks isTTY and can block. Checking isTTY alone would also skip files,
  // which is harmless: a file never backs up.
  if (!stream || stream.isTTY) return null;
  let dropped = 0;
  return () => {
    if (stream.writableLength <= LOG_BACKPRESSURE_BYTES) {
      if (dropped) {
        const lost = dropped;
        dropped = 0;
        try {
          stream.write(`[tokenproxy] resumed ${label} logging; dropped ${lost} writes while the reader was stalled\n`);
        } catch { /* the stream is gone; nothing to report to */ }
      }
      return false;
    }
    dropped++;
    return true;
  };
}

const stdoutStalled = guardStreamBackpressure(process.stdout, 'stdout');
const stderrStalled = guardStreamBackpressure(process.stderr, 'stderr');

if (stdoutStalled || stderrStalled) {
  for (const [method, stalled] of [
    ['log', stdoutStalled], ['info', stdoutStalled], ['debug', stdoutStalled],
    ['warn', stderrStalled], ['error', stderrStalled], ['trace', stderrStalled],
  ]) {
    const original = console[method];
    if (typeof original !== 'function' || !stalled) continue;
    console[method] = (...args) => {
      if (stalled()) return;
      original.apply(console, args);
    };
  }
}

// Optional second listener that serves ONLY the OpenAI-compatible endpoint.
// Set API_PORT to split the API off the dashboard port, so the API can be
// exposed (tunnel, mesh, Zero Trust) without exposing the dashboard with it.
// API_HOSTNAME defaults to loopback -- widen it deliberately, never by accident.
const API_PORT = Number(process.env.API_PORT || 0);
const API_HOSTNAME = process.env.API_HOSTNAME || '127.0.0.1';

// Paths reachable on the API port. Everything else 404s there, including the
// dashboard and its /api/* routes, which is the entire point of the split.
const API_PREFIXES = ['/v1', '/v1beta', '/responses', '/codex'];

function isApiPath(url) {
  const p = String(url || '').split('?')[0];
  return API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

let apiServerStarted = false;

// A crash in this process used to be silent from the operator's side: Node
// prints its own message and exits, and nothing here identified the process,
// the port it was serving, or that the thing which died was the router rather
// than the CLI wrapper around it. The tray's auto-restart then brought it back,
// so the visible symptom was an unexplained blip and a report with no output in
// it (#1814).
//
// These handlers do NOT change whether the process dies. Installing a listener
// for either event suppresses Node's default exit, so each one exits
// explicitly afterwards: continuing past an unknown exception is how a gateway
// starts answering with corrupted state, which is worse than restarting.
// The only thing that changes is that the log says what happened.
function describeCrash(kind, error) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack || ""}`
    : `${typeof error}: ${String(error)}`;
  // Read from the environment at crash time rather than closing over a
  // constant: the port is assigned later in this file than these handlers are
  // installed, and a crash handler that throws is worse than no handler.
  const port = process.env.PORT ? `, port ${process.env.PORT}` : "";
  return `[tokenproxy] ${kind} in the server process (pid ${process.pid}${port}). `
    + `The process is exiting; the tray will restart it if it is managing this `
    + `one.\n${detail}`;
}

// console.error is the wrong channel for a message written immediately before
// process.exit(), and it fails two different ways that both end in an empty
// crash report.
//
// Node's own "A note on process I/O" gives the first: a stdio write is
// ASYNCHRONOUS for a TTY on Windows and for a pipe on POSIX. That is `tokenproxy
// run` in a Windows terminal (#1891) and the CLI/tray launcher everywhere else
// (#1814) — between them, both reports. Whatever is still queued when the
// process exits is discarded, so the handler above wrote a description nobody
// ever saw.
//
// The backpressure guard at the top of this file supplies the second: a stalled
// log reader puts console.error on its DROP path, so the one message that most
// needs to survive is the one thrown away. Measured here, not inferred — with
// stderr piped to a reader that is not consuming, the crash line never appears.
//
// fs.writeSync goes at fd 2 directly, which beats both -- but only with a real
// wait behind it. Node leaves a piped fd 2 NON-BLOCKING on POSIX, so a write
// into a full pipe throws EAGAIN rather than blocking, and a tight retry loop
// burns every attempt in microseconds while the reader is still behind.
// Measured against a reader stalled for half a second: 1000 immediate retries
// all returned EAGAIN and the message was lost; sleeping 20ms between them
// delivered it in 25 waits. Atomics.wait is the only genuine synchronous sleep
// available here, and the crash path is exactly where blocking is correct.
//
// The deadline is the ceiling: a reader that never drains at all still loses
// the message, because at that point there is nowhere for it to go.
const CRASH_WRITE_DEADLINE_MS = 2000;
const crashWriteSleeper = new Int32Array(new SharedArrayBuffer(4));
let crashReported = false;

function reportCrashSync(text) {
  crashReported = true;
  const buffer = Buffer.from(`${text}\n`, "utf8");
  const deadline = Date.now() + CRASH_WRITE_DEADLINE_MS;
  let written = 0;
  while (written < buffer.length) {
    try {
      written += fs.writeSync(2, buffer, written);
    } catch (error) {
      // Anything but EAGAIN means fd 2 is closed or broken, so there is nowhere
      // left to report to and retrying cannot help.
      if (error.code !== "EAGAIN" || Date.now() >= deadline) return false;
      Atomics.wait(crashWriteSleeper, 0, 0, 20);
    }
  }
  return true;
}

process.on("uncaughtException", (error) => {
  // A client that hangs up mid-response arrives here as well as through the
  // rejection path below: an unhandled 'error' on the socket or on the response
  // IS an uncaught exception. Taking the gateway down for every other client
  // because one walked away is the crash in #1814, so treat it exactly as the
  // rejection path already treats it.
  if (isClientDisconnect(error)) return;
  reportCrashSync(describeCrash("Uncaught exception", error));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  // A client that walks away mid-request produces a rejection nobody awaited,
  // which is already swallowed on the handler path below. One that reaches here
  // is the same non-event and must not take the server down with it.
  if (isClientDisconnect(reason)) return;
  reportCrashSync(describeCrash("Unhandled promise rejection", reason));
  process.exit(1);
});

// Last resort, because the handlers above only see what they are handed and the
// loudest silent exit is not theirs: Next's standalone entry answers a failed
// listen with `console.error(err); process.exit(1)` (start-server.js), which
// loses its message to exactly the asynchrony described above. The operator is
// left with a dead port and an empty log, which is what "it dies right after it
// says it is ready" looks like from outside. Nothing here can recover that
// detail, but naming the exit turns a vanished process into one with a code.
process.on("exit", (code) => {
  if (code === 0 || crashReported) return;
  reportCrashSync(
    `[tokenproxy] the server process (pid ${process.pid}) is exiting with code ${code}. `
      + `If nothing above says why, a port already in use is the usual cause; `
      + `\`tokenproxy run --log\` shows the failure that preceded this line.`
  );
});


// A client that hangs up mid-stream is meant to abort the upstream request:
// Next builds `request.signal` from `res` emitting 'close' before it finished,
// and open-sse/utils/streamHandler.js cancels the provider reader off that.
// Bun's node:http compat reports none of it. Measured on Bun 1.3.13 against a
// destroyed client socket on a streaming POST: `res` 'close' never fires,
// `req.socket` 'close' never fires, `res.destroyed` stays undefined,
// `res.write()` keeps returning true and never throws, and 'drain' fires as if
// the bytes were delivered. There is no in-process signal left to bridge, so
// the provider keeps generating — and billing for — a stream nobody reads
// (#3559). Nothing here can fix that; running the server on Node can, so say
// so once rather than let it cost money silently.
if (typeof globalThis.Bun !== 'undefined') {
  console.warn(
    '  ! Bun runtime: client disconnects are not detectable (Bun does not emit ' +
      'response close). An abandoned streaming request keeps running upstream and ' +
      'keeps billing. Run the server on Node to get disconnect-driven aborts.'
  );
}


// Per-process secret proving x-tp-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-tp-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.TOKENPROXY_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, 'src', 'sse', 'services', 'backgroundTokenRefresh.js');
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error('[BackgroundTokenRefresh] start failed:', e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error('[BackgroundTokenRefresh] import failed:', e && e.message ? e.message : e);
      }
    });
}

// A request the client abandoned. Node reports this several ways depending on
// where the socket died, and none of them mean the server misbehaved.
const CLIENT_DISCONNECT_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

function isClientDisconnect(err, req, res) {
  if (!err) return false;
  if (CLIENT_DISCONNECT_CODES.has(err.code)) return true;
  if (err.message === 'aborted' || err.message === 'request aborted') return true;
  // Node sets aborted/destroyed on the message once the peer is gone; a
  // rejection raised while that is true cannot be delivered to anyone.
  return Boolean(req?.aborted || req?.destroyed || res?.destroyed);
}

    // One LOG.boot line after the server binds (docs/logging-design.md). Every
// field is best-effort: nothing here may throw into boot.
//
// This file is CJS and OUTSIDE the webpack bundle, so it cannot reach the
// bundled decide.js — and `src/` is not on disk in the published standalone
// (the comment above initializeApp says so), which makes a dynamic import of
// the source file a silent no-op in production. The line is therefore emitted
// here with the same format and written straight to the same two sinks
// (console for journald/dashboard, decisions.ndjson for file grep). All
// values are self-generated scalars, so the shared redaction chokepoint has
// nothing to add; whitespace is still flattened defensively.
async function emitBootLine() {
  try {
    let sha = 'unknown';
    for (const candidate of [path.join(__dirname, 'BUILD_SHA'), path.join(__dirname, 'cli', 'BUILD_SHA'), path.join(__dirname, '..', 'BUILD_SHA')]) {
      try {
        const text = fs.readFileSync(candidate, 'utf8').trim();
        if (text) { sha = text.slice(0, 12); break; }
      } catch { /* try the next candidate */ }
    }
    let version = 'unknown';
    try {
      version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
    } catch { /* keep unknown */ }
    const [nodeMajor, nodeMinor] = process.versions.node.split('.');
    const dataDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'tokenproxy')
      : path.join(os.homedir(), '.tokenproxy');
    const fields = {
      sha,
      version: String(version).slice(0, 60),
      node: `${nodeMajor}.${nodeMinor}`,
      db: path.basename(process.env.DATA_DIR || dataDir).replace(/^\./, '') || 'unknown',
      logdecisions: process.env.TOKENPROXY_LOG_DECISIONS === 'off' ? 'off' : 'on',
    };
    const scalar = (v) => String(v).replace(/[\s -]+/g, '_').slice(0, 60);
    const line = `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} LOG.boot `
      + Object.entries(fields).map(([k, v]) => `${k}=${scalar(v)}`).join(' ');
    console.log(line);
    try {
      const sink = path.join(process.env.DATA_DIR || dataDir, 'logs', 'decisions.ndjson');
      fs.mkdirSync(path.dirname(sink), { recursive: true, mode: 0o700 });
      fs.appendFileSync(sink, JSON.stringify({ ts: new Date().toISOString(), cls: 'LOG', verdict: 'boot', ...fields }) + '\n', { mode: 0o600 });
    } catch { /* the ndjson sink is best-effort; the journal line already carries it */ }
  } catch { /* boot logging must never throw */ }
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === 'function');
  const rest = args.filter((a) => typeof a !== 'function');
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    if (String(req.headers.upgrade || '').toLowerCase() === 'h2c') {
      delete req.headers.upgrade;
      delete req.headers['http2-settings'];
      req.headers.connection = 'close';
      res.shouldKeepAlive = false;
    }
    try { globalThis.__tokenproxyTechnicalTelemetry?.observe(req,res); }
    catch { /* Optional technical instrumentation cannot reject HTTP work. */ }
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
    const xff = req.headers['x-forwarded-for'];
    const xRealIp = req.headers['x-real-ip'];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy =
      socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(',')[0].trim() : '');
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers['x-tp-real-ip'];
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-tp-via-proxy'];
    delete req.headers['x-tp-peer-token'];
    req.headers['x-tp-real-ip'] = ip;
    req.headers['x-tp-peer-token'] = PEER_TOKEN;
    if (viaProxy) req.headers['x-tp-via-proxy'] = '1';
    // A client that closes the socket mid-request makes Node abort the incoming
    // message, and the handler's promise rejects with "Error: aborted at
    // abortIncoming". Nothing awaited it, so it surfaced as an unhandled
    // rejection in the log even though the request simply went away. Swallow
    // only that class; anything else is a real failure and must still be seen.
    const result = handler(req, res);
    if (result && typeof result.catch === 'function') {
      return result.catch((err) => {
        if (isClientDisconnect(err, req, res)) return;
        throw err;
      });
    }
    return result;
  };
  // Next creates one server; guard anyway so a second call cannot fight over the port.
  if (API_PORT && !apiServerStarted) {
    apiServerStarted = true;
    origCreate((req, res) => {
      if (!isApiPath(req.url)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Not found. This port serves the API only.',
              type: 'invalid_request_error',
            },
          })
        );
        return;
      }
      return wrapped(req, res);
    })
      .listen(API_PORT, API_HOSTNAME, () => {
        console.log(
          `  ▲ API-only listener on http://${API_HOSTNAME}:${API_PORT} (${API_PREFIXES.join(', ')})`
        );
      })
      .on('error', (err) => {
        console.error(
          `  ✗ API-only listener failed on ${API_HOSTNAME}:${API_PORT}: ${err.message}`
        );
      });
  }

  const options = rest[0];
  let server;
  if (options == null || (typeof options === 'object' && !Array.isArray(options))) {
    const configuredUpgrade = options?.shouldUpgradeCallback;
    const nativeOptions = { ...options };
    if (configuredUpgrade === undefined || typeof configuredUpgrade === 'function') {
      // Supported by Node 22.21+/24.9+; older runtimes ignore this option.
      // Keep h2c with the native HTTP/1.1 parser, including its body lifecycle.
      nativeOptions.shouldUpgradeCallback = function (req) {
        if (String(req.headers.upgrade || '').toLowerCase() === 'h2c') return false;
        return configuredUpgrade
          ? configuredUpgrade.call(this, req)
          : this.listenerCount('upgrade') > 0;
      };
    }
    server = origCreate(nativeOptions, wrapped);
  } else {
    // Preserve Node's validation for invalid createServer option types.
    server = origCreate(...rest, wrapped);
  }
  // Without a listener Node's default is to destroy the socket, which is right,
  // but a malformed or abandoned request then logs nothing at all. Keep the
  // destroy and say which it was, at most once per socket.
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed && !isClientDisconnect(err)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
  });
  server.once('listening', () => {
    emitBootLine();
    startBackgroundTokenRefreshFromCustomServer();
  });
  // Node 20 has no native upgrade policy. Retain only its raw-socket fallback.
  // Node 26 upgrade streams no longer carry request-body bytes; never parse
  // those streams as if they used the older raw-socket contract.
  if (typeof server.shouldUpgradeCallback !== 'function') {
    const maxReplayBodyBytes = require('./open-sse/config/proxyBodyLimit.cjs').proxyClientMaxBodyBytes();
    const origEmit = server.emit;
    server.emit = function (event, ...eventArgs) {
      const [req, socket, head] = eventArgs;
      if (event !== 'upgrade' || String(req.headers.upgrade || '').toLowerCase() !== 'h2c') {
        return origEmit.call(this, event, ...eventArgs);
      }

      socket.once('error', () => socket.destroy());
      if (req.headers['transfer-encoding']) {
        // The old raw-socket fallback cannot decode HTTP transfer framing.
        // Refuse before the handler sees an empty or partially decoded body.
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
        return true;
      }
      const contentLength = Number(req.headers['content-length'] || 0);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        socket.destroy();
        return true;
      }
      if (contentLength > maxReplayBodyBytes) {
        socket.end('HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
        return true;
      }
      // Ignore pipelined bytes after this Connection: close request. Retain
      // at most the admitted Content-Length, including a coalesced head.
      const chunks = [head.subarray(0, contentLength)];
      let received = chunks[0].length;

      const serve = () => {
        // Replay the upgraded request through the existing HTTP/1.1 handler.
        const replay = new http.IncomingMessage(socket);
        Object.assign(replay, {
          method: req.method,
          url: req.url,
          headers: req.headers,
          complete: true,
        });
        if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
        replay.push(null);
        const res = new http.ServerResponse(replay);
        res.shouldKeepAlive = false;
        res.assignSocket(socket);
        res.once('finish', () => socket.end());
        Promise.resolve()
          .then(() => wrapped(replay, res))
          .catch((error) => {
            console.error('Failed to downgrade h2c request', error);
            socket.destroy();
          });
      };
      if (received >= contentLength) serve();
      else {
        const abandon = () => socket.destroy();
        socket.once('end', abandon);
        socket.on('data', function readBody(chunk) {
          const bodyChunk = chunk.subarray(0, contentLength - received);
          chunks.push(bodyChunk);
          received += bodyChunk.length;
          if (received < contentLength) return;
          socket.off('data', readBody);
          socket.off('end', abandon);
          serve();
        });
        socket.resume();
      }
      delete req.headers.upgrade;
      delete req.headers['http2-settings'];
      req.headers.connection = 'close';
      return true;
    };
  }
  return server;
};

// DOCKER.md and docs/deployment.md both state the server does not start without
// JWT_SECRET, but the only check lived at module scope in
// src/lib/auth/dashboardSession.js, so it ran on the first request that imported
// it and never before. A container therefore reported Up with its port
// published, answered /api/health with 200, and threw on every dashboard and
// login request -- which a reverse proxy in front of it surfaces as a 502, with
// nothing in `docker logs` naming the cause (#1544). The /v1 gateway keeps
// working in that state, which is why it survives unnoticed until someone opens
// the dashboard.
//
// Checking here makes the documented contract true and puts the reason on fd 2,
// where `docker logs` reads it. Every launcher routes through this entry point:
// the image's CMD, the CLI, pm2 and `npm start` all run `node custom-server.js`.
function requireJwtSecret() {
  if (process.env.JWT_SECRET) return true;

  // Next loads .env itself, after this file has already handed over, so a secret
  // configured that way is not visible yet. Load it the same way Next is about
  // to; a build whose tracing dropped @next/env keeps the previous behaviour
  // rather than refusing to boot over a missing loader.
  try {
    require('@next/env').loadEnvConfig(__dirname, false, { info() {}, error() {} });
  } catch { /* no env loader here; the direct check below still stands */ }
  if (process.env.JWT_SECRET) return true;

  reportCrashSync(
    '[tokenproxy] JWT_SECRET is not set, so the dashboard session cookie cannot be '
      + 'signed and every dashboard request would fail while the gateway kept '
      + 'answering. Set it to a strong random value (32+ characters) in the '
      + "environment, in .env beside the server, or with `docker run -e "
      + "JWT_SECRET='...'`. See DOCKER.md and docs/deployment.md."
  );
  return false;
}

if (require.main === module) {
  if (!requireJwtSecret()) process.exit(1);
  // The start script used to pass --port 20127, and a CLI flag beats the PORT
  // environment variable, so setting PORT in .env or pm2 did nothing and the
  // server always came up on 20127 (#2602). The flag is gone; default here
  // instead, which an explicit PORT still overrides.
  if (!process.env.PORT) process.env.PORT = '20128';
  const standalone = path.join(__dirname, 'server.js');
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve('next/dist/bin/next');
    process.argv = [process.argv[0], nextBin, 'start', ...process.argv.slice(2)];
    require(nextBin);
  }
}
