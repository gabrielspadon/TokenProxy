import http from "http";
import { URL } from "url";
import { CODEX_CONFIG, DEVIN_CONFIG, OAUTH_TIMEOUT, TRAE_CONFIG, WINDSURF_CONFIG, ZED_HOSTED_CONFIG } from "../constants/oauth.js";

// Loopback origin guard for local callback proxies.
// Legit OAuth redirects are top-level navigations (no `Origin` header); a cross-site
// page issuing `fetch(..., {mode:"no-cors"})` to scan + hit 127.0.0.1 always sends
// `Origin: https://attacker`. Reject any non-loopback Origin to block login-CSRF.
function isLoopbackOrigin(origin) {
  if (!origin) return true; // navigation redirect — allow
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}


/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(new Error(`Port ${fixedPort} is already in use. Please close other applications using this port.`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Poll until the OAuth callback has stored its params, or give up.
 *
 * Both timers are cleared on every exit. The hand-rolled copies of this loop
 * cleared them only on the success branch, so a wait that timed out left a
 * 100ms interval running for the life of the process.
 *
 * @param {Function} getParams - Returns the callback params once they arrive
 * @param {number} timeoutMs - Deadline in milliseconds
 * @param {number} pollMs - Poll period in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallbackParams(getParams, timeoutMs = OAUTH_TIMEOUT, pollMs = 100) {
  return new Promise((resolve, reject) => {
    let interval = null;
    let timeout = null;
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null; }
      if (timeout) { clearTimeout(timeout); timeout = null; }
    };

    timeout = setTimeout(() => {
      stop();
      reject(new Error("Authentication timeout (5 minutes)"));
    }, timeoutMs);

    interval = setInterval(() => {
      const params = getParams();
      if (params) {
        stop();
        resolve(params);
      }
    }, pollMs);
  });
}

// A fixed-port callback proxy must answer on whatever the provider's registered
// redirect URI resolves to. Codex registers http://localhost:1455/auth/callback,
// and on a dual-stack host `localhost` resolves ::1 FIRST (/etc/hosts carries
// `::1 localhost`), so a listener bound only to 127.0.0.1 is never reached: the
// browser connects to [::1]:1455 and gets ECONNREFUSED. The redirect URI is fixed
// by OpenAI's client registration, so the bind is what has to change.
//
// Binding the unspecified address would also fix reachability and is NOT
// acceptable: measured on this host, `server.listen(port)` with no host reaches
// the LAN address too, which would expose a port carrying an authorization code
// beyond loopback. Two explicit loopback listeners reach ::1 and 127.0.0.1 and
// refuse everything else.
//
// A host with IPv6 disabled still gets a working v4 listener; only a total
// failure, where NEITHER family binds, is an error. EADDRINUSE on either family
// is reported as port_busy, because a half-held port fails the next attempt too.
function listenLoopbackDual(server6, server4, port) {
  const bind = (server, host, ipv6Only) => new Promise((resolve) => {
    const onError = (err) => resolve({ ok: false, code: err.code });
    server.once("error", onError);
    server.listen({ port, host, ...(ipv6Only ? { ipv6Only: true } : {}) }, () => {
      server.removeListener("error", onError);
      resolve({ ok: true });
    });
  });
  // v6 first, with ipv6Only set so it cannot swallow the v4 address; the v4 bind
  // that follows then either succeeds or reports a genuine conflict.
  return bind(server6, "::1", true).then(async (v6) => {
    const v4 = await bind(server4, "127.0.0.1", false);
    if (!v6.ok && !v4.ok) {
      return { ok: false, busy: v6.code === "EADDRINUSE" || v4.code === "EADDRINUSE", reason: v4.code || v6.code };
    }
    if (v6.code === "EADDRINUSE" || v4.code === "EADDRINUSE") {
      return { ok: false, busy: true, reason: "EADDRINUSE" };
    }
    return { ok: true };
  });
}

// Closes every listener a proxy holds. Leaking one keeps the fixed port bound for
// the full timeout, and the next sign-in then hits EADDRINUSE on a port nothing
// is waiting on.
function closeAll(servers) {
  for (const server of servers) {
    if (server) server.close();
  }
}

// One lifecycle per callback proxy, owning its listeners and its idle timer.
// Six copies of the same singleton pattern each carried the same three faults,
// which this makes inexpressible rather than merely fixed:
//
// 1. LIVENESS ANSWERS TO THE KERNEL. `running()` asks the listeners themselves
//    (`server.listening`) instead of trusting a non-empty variable. A listener
//    that stopped without going through stop() no longer reads as running, so the
//    already-started fast path cannot report success for a port nothing holds.
// 2. THE TIMER CANNOT BE ORPHANED. The handle belongs to the lifecycle and
//    `adopt()` clears the one it replaces before storing the next. A single
//    module-level variable could be overwritten by a second successful bind,
//    leaving the first proxy bound with no timer left to close it.
// 3. A PENDING SESSION DIES WITH ITS LISTENER. Only the listener that just closed
//    could have completed it, so leaving it behind makes poll-status answer
//    "pending" against a dead port for the full deadline, which is what an
//    operator experiences as the sign-in window doing nothing. A session that
//    already reached done or error is the OUTCOME the dashboard is about to read
//    (the handler sets it, then stops the proxy in its `finally`), so it survives
//    and poll-status clears it.
//
// FAILURE DIRECTION. The permissive path is the already-running fast path. It is
// now gated on `running()` rather than on a variable being set, so a leaked or
// externally-closed listener takes the REBIND path instead of being reported as a
// working proxy. `dropPendingSessions` only ever deletes `status === "pending"`.
function createProxyLifecycle({ timeoutMs, onStop }) {
  let servers = [];
  let timer = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const release = () => {
    clearTimer();
    closeAll(servers);
    servers = [];
  };

  const stop = () => {
    release();
    onStop?.();
  };

  return {
    stop,
    running: () => servers.some((server) => server?.listening),
    // Drop whatever this lifecycle still holds before a fresh bind, so a
    // half-held listener is never abandoned by the attempt that replaces it.
    reset: release,
    // Take ownership of freshly bound listeners and arm the only timer that will
    // ever close them.
    adopt(next) {
      clearTimer();
      servers = next.filter(Boolean);
      timer = setTimeout(stop, timeoutMs);
    },
  };
}

// A state whose listener is gone can only mislead, so it goes; a terminal one is
// the result the dashboard still has to read, so it stays.
function dropPendingSessions(sessions) {
  for (const [state, session] of sessions) {
    if (session?.status === "pending") sessions.delete(state);
  }
}

// A sign-in carrying 2FA, an account chooser or a password manager routinely runs
// past five minutes, and when the proxy closed first the callback landed on a dead
// port. Ten minutes matches the deadline the grant-side wait already uses for the
// session-registering proxies, so proxy and poll now expire together.
const FIXED_PORT_PROXY_TIMEOUT_MS = 600000; // 10 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();
const codexProxy = createProxyLifecycle({
  timeoutMs: FIXED_PORT_PROXY_TIMEOUT_MS,
  onStop: () => dropPendingSessions(pendingExchanges),
});
// The dashboard port of the attempt in flight. Read at REQUEST time, not captured
// when the handler is built: the fast path keeps the first attempt's handler
// alive, and a captured port sent Mode B's 302 to whatever port the first attempt
// happened to use, which a later sign-in from a different port never occupies.
let codexAppPort = null;

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  pendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state) {
  pendingExchanges.delete(state);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${safeMessage}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort) {
  return new Promise((resolve) => {
    // Set before the fast path returns, so the attempt that reuses a running
    // proxy still owns the redirect target.
    codexAppPort = appPort;
    if (codexProxy.running()) {
      resolve({ success: true });
      return;
    }
    // Anything still held is not listening, or `running()` would have said so.
    codexProxy.reset();

    const handler = async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? pendingExchanges.get(state) : null;

      // Mode A: server-side exchange (session registered)
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          // Lazy import to avoid circular deps
          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "codex",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "codex",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
        } finally {
          stopCodexProxy();
        }
        return;
      }

      // Mode B: legacy channel fallback — 302 redirect to app /callback
      const redirectUrl = `http://localhost:${codexAppPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopCodexProxy();
    };

    // One handler, two listeners: ::1 and 127.0.0.1. Codex's redirect URI names
    // `localhost`, which resolves to either depending on the host's resolver order.
    const server6 = http.createServer(handler);
    const server4 = http.createServer(handler);
    listenLoopbackDual(server6, server4, CODEX_PORT).then((outcome) => {
      if (!outcome.ok) {
        closeAll([server6, server4]);
        resolve({ success: false, reason: outcome.busy ? "port_busy" : outcome.reason });
        return;
      }
      codexProxy.adopt([server6, server4]);
      resolve({ success: true });
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy() {
  codexProxy.stop();
}

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy, now over the shared lifecycle. The older comment
// here kept the two as hand-maintained copies "to keep the codex hot-path
// byte-equivalent"; that predates a lifecycle bug which was present in both
// copies at once, so the shared helper is what keeps them parallel from here.
// ───────────────────────────────────────────────────────────────────────────

const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();
const xaiProxy = createProxyLifecycle({
  timeoutMs: FIXED_PORT_PROXY_TIMEOUT_MS,
  onStop: () => dropPendingSessions(xaiPendingExchanges),
});
let xaiAppPort = null;

export function registerXaiSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function clearXaiSession(state) {
  xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort) {
  return new Promise((resolve) => {
    xaiAppPort = appPort;
    if (xaiProxy.running()) {
      resolve({ success: true });
      return;
    }
    xaiProxy.reset();

    const handler = async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? xaiPendingExchanges.get(state) : null;

      // Mode A: server-side exchange
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "xai",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(false, err.message));
        } finally {
          stopXaiProxy();
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${xaiAppPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy();
    };

    // xAI's registered redirect URI names 127.0.0.1 explicitly, so the v4 listener
    // is the one that matters. The v6 listener costs nothing and keeps both
    // fixed-port proxies on one shape, which is what stops this pair drifting.
    const server6 = http.createServer(handler);
    const server4 = http.createServer(handler);
    listenLoopbackDual(server6, server4, XAI_PROXY_PORT).then((outcome) => {
      if (!outcome.ok) {
        closeAll([server6, server4]);
        resolve({ success: false, reason: outcome.busy ? "port_busy" : outcome.reason });
        return;
      }
      xaiProxy.adopt([server6, server4]);
      resolve({ success: true });
    });
  });
}

export function stopXaiProxy() {
  xaiProxy.stop();
}

// ───────────────────────────────────────────────────────────────────────────
// Trae dynamic-port proxy. Singleton session (one connect at a time per provider).
// Callback path = /callback with params refreshToken + loginHost.
// ───────────────────────────────────────────────────────────────────────────

let traeProxyPort = null;
let traeSession = null;
const traeProxy = createProxyLifecycle({
  timeoutMs: TRAE_CONFIG.oauthTimeoutMs,
  onStop: () => {
    traeProxyPort = null;
    if (traeSession?.status === "pending") traeSession = null;
  },
});

export function registerTraeSession({ state }) {
  if (!state) return false;
  traeSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getTraeSessionStatus(state) {
  if (!traeSession) return null;
  if (state && traeSession.state !== state) return null;
  return traeSession;
}
export function clearTraeSession(state) {
  if (!state || (traeSession && traeSession.state === state)) traeSession = null;
}

export function startTraeProxy() {
  return new Promise((resolve) => {
    if (traeProxy.running()) {
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
      return;
    }
    traeProxy.reset();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== TRAE_CONFIG.callbackPath && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = traeSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Trae login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches (legit redirects send no Origin),
      // and reject state mismatch when state is present.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (cbState && session.state && cbState !== session.state) {
        session.status = "error";
        session.error = "Trae callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopTraeProxy();
        return;
      }
      // Pass the raw callback query to exchangeTokens → parseTraeCallback
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("trae", rawCallback);
        const connection = await createProviderConnection({
          provider: "trae",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresIn
            ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
            : null,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopTraeProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      traeProxyPort = server.address().port;
      traeProxy.adopt([server]);
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopTraeProxy() {
  traeProxy.stop();
}

// ───────────────────────────────────────────────────────────────────────────
// Windsurf dynamic-port proxy. Singleton session.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyPort = null;
let windsurfSession = null;
const windsurfProxy = createProxyLifecycle({
  timeoutMs: WINDSURF_CONFIG.oauthTimeoutMs,
  onStop: () => {
    windsurfProxyPort = null;
    if (windsurfSession?.status === "pending") windsurfSession = null;
  },
});

export function registerWindsurfSession({ state }) {
  if (!state) return false;
  windsurfSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getWindsurfSessionStatus(state) {
  if (!windsurfSession) return null;
  if (state && windsurfSession.state !== state) return null;
  return windsurfSession;
}
export function clearWindsurfSession(state) {
  if (!state || (windsurfSession && windsurfSession.state === state)) windsurfSession = null;
}

export function startWindsurfProxy() {
  return new Promise((resolve) => {
    if (windsurfProxy.running()) {
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
      return;
    }
    windsurfProxy.reset();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== WINDSURF_CONFIG.callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = windsurfSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Windsurf login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches, and require state present + matching.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (!cbState || !session.state || cbState !== session.state) {
        session.status = "error";
        session.error = "Windsurf callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopWindsurfProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("windsurf", rawCallback, null, null, session.state);
        const connection = await createProviderConnection({
          provider: "windsurf",
          authType: "api_key",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopWindsurfProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      windsurfProxyPort = server.address().port;
      windsurfProxy.adopt([server]);
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopWindsurfProxy() {
  windsurfProxy.stop();
}

// ───────────────────────────────────────────────────────────────────────────
// Devin Cloud PKCE callback proxy. Singleton session.

let devinProxyPort = null;
let devinSession = null;
const devinProxy = createProxyLifecycle({
  timeoutMs: DEVIN_CONFIG.oauthTimeoutMs,
  onStop: () => {
    devinProxyPort = null;
    if (devinSession?.status === "pending") devinSession = null;
  },
});

export function registerDevinSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier) return false;
  devinSession = { state, codeVerifier, redirectUri, status: "pending", createdAt: Date.now() };
  return true;
}
export function getDevinSessionStatus(state) {
  if (!devinSession) return null;
  if (state && devinSession.state !== state) return null;
  return devinSession;
}
export function clearDevinSession(state) {
  if (!state || (devinSession && devinSession.state === state)) devinSession = null;
}

export function startDevinProxy() {
  return new Promise((resolve) => {
    if (devinProxy.running()) {
      resolve({ success: true, port: devinProxyPort, callbackUrl: `http://127.0.0.1:${DEVIN_CONFIG.callbackPort}${DEVIN_CONFIG.callbackPath}` });
      return;
    }
    devinProxy.reset();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== DEVIN_CONFIG.callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const session = devinSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("No active Devin login session");
        return;
      }
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Cross-origin callback rejected");
        return;
      }
      const state = url.searchParams.get("state");
      if (!state || state !== session.state) {
        session.status = "error";
        session.error = "Devin callback state mismatch";
        res.writeHead(400, { "Content-Type": "text/plain" }).end(session.error);
        stopDevinProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("devin", rawCallback, session.redirectUri, session.codeVerifier, session.state);
        const connection = await createProviderConnection({ provider: "devin", authType: "oauth", ...tokenData, testStatus: "active" });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/plain" }).end("Devin login completed. You can close this tab.");
      } catch (error) {
        session.status = "error";
        session.error = error.message;
        res.writeHead(500, { "Content-Type": "text/plain" }).end("Devin login failed. You can close this tab.");
      } finally {
        stopDevinProxy();
      }
    });
    server.listen(DEVIN_CONFIG.callbackPort, "127.0.0.1", () => {
      devinProxyPort = server.address().port;
      devinProxy.adopt([server]);
      resolve({ success: true, port: devinProxyPort, callbackUrl: `http://127.0.0.1:${devinProxyPort}${DEVIN_CONFIG.callbackPath}` });
    });
    server.on("error", (error) => {
      resolve({
        success: false,
        reason: error.code === "EADDRINUSE"
          ? `Devin OAuth requires 127.0.0.1:${DEVIN_CONFIG.callbackPort}; the port is already in use`
          : error.message,
      });
    });
  });
}

export function stopDevinProxy() {
  devinProxy.stop();
}

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. Singleton session.
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyPort = null;
let zedSession = null;
const zedProxy = createProxyLifecycle({
  timeoutMs: ZED_HOSTED_CONFIG.oauthTimeoutMs,
  onStop: () => {
    console.log(`[Zed proxy] stopping (port ${zedProxyPort || "-"})`);
    zedProxyPort = null;
    if (zedSession?.status === "pending") zedSession = null;
  },
});

export function registerZedSession({ state, codeVerifier }) {
  if (!state || !codeVerifier) return false;
  zedSession = { state, codeVerifier, status: "pending", createdAt: Date.now() };
  return true;
}
export function getZedSessionStatus(state) {
  if (!zedSession) return null;
  if (state && zedSession.state !== state) return null;
  return zedSession;
}
export function clearZedSession(state) {
  if (!state || (zedSession && zedSession.state === state)) zedSession = null;
}

export function startZedProxy(preferredPort = 0) {
  return new Promise((resolve) => {
    if (zedProxy.running()) {
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
      return;
    }
    zedProxy.reset();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      // Log path + redacted params (access_token is the RSA-encrypted credential).
      const redacted = Object.fromEntries(url.searchParams);
      for (const k of ["access_token", "user_id", "code_verifier", "state"]) {
        if (redacted[k]) redacted[k] = "<redacted>";
      }
      console.log("[Zed proxy]", req.method, url.pathname, JSON.stringify(redacted));
      if (url.pathname !== "/" && url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = zedSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Zed login session"));
        return;
      }
      // Anti-CSRF: Zed tokens are RSA-encrypted to our keypair so they can't be
      // forged cross-site, but still reject cross-origin fetches for defense-in-depth.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      // Pass raw callback path+query to exchangeTokens → parseZedCallbackPayload.
      // codeVerifier carries the encoded RSA private key for decryption.
      const rawCallback = url.search ? `${url.pathname}?${url.searchParams.toString()}` : url.pathname;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("zed", rawCallback, null, session.codeVerifier, session.state);
        const connection = await createProviderConnection({
          provider: "zed",
          authType: "oauth",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopZedProxy();
      }
    });
    const tryPort = Number(preferredPort) || 0;
    server.on("error", (err) => {
      // If the preferred port (e.g. 58443) is busy, fall back to a random port.
      if (err.code === "EADDRINUSE" && tryPort !== 0) {
        console.log(`[Zed proxy] port ${tryPort} busy, falling back to random`);
        server.listen(0, "127.0.0.1", () => {
          zedProxyPort = server.address().port;
          zedProxy.adopt([server]);
          console.log(`[Zed proxy] listening on random port ${zedProxyPort}`);
          resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
        });
      } else {
        console.log(`[Zed proxy] listen error: ${err.message}`);
        resolve({ success: false, reason: err.message });
      }
    });
    server.listen(tryPort, "127.0.0.1", () => {
      zedProxyPort = server.address().port;
      zedProxy.adopt([server]);
      console.log(`[Zed proxy] listening on port ${zedProxyPort}`);
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
    });
  });
}

export function stopZedProxy() {
  zedProxy.stop();
}

