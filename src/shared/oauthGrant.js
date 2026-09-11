"use client";

// One OAuth grant, from authorize to a saved connection, for every flow the
// gateway speaks. The credential itself never passes through this module in
// the browser-redirect flows; only codes, states, and the gateway's own
// connection summary {id, provider, email, displayName} do.
import { call } from "@/shared/api";

const PROXY_QUERY = ["codex", "xai"]; // start-proxy?app_port=&state=&code_verifier=&redirect_uri=
const PROXY_SESSION = ["trae", "windsurf", "zed", "devin"]; // start-proxy then register-session
// Flows that never navigate the browser, so they open no sign-in window.
const WINDOWLESS_FLOWS = new Set(["device_code", "browser_token", "import_token"]);
const POPUP_BLOCKED = "The browser blocked the sign-in window. Allow pop-ups for this page, then try again.";
const POPUP_CLOSED = "The sign-in window was closed before it opened the provider. Start again from the connection.";

export const requiresCredentialDocument = provider => PROXY_QUERY.includes(provider) || PROXY_SESSION.includes(provider);

export function credentialDocument(text, force = false) {
  let body; try { body = JSON.parse(text || ''); } catch { throw new Error('Enter valid credential JSON.'); }
  if (Array.isArray(body?.accounts)) {
    if (body.accounts.length !== 1) throw new Error('Select a document containing exactly one account.');
    body = body.accounts[0];
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Enter one account object.');
  if (!['accessToken', 'refreshToken', 'idToken', 'apiKey'].some(key => typeof body[key] === 'string' && body[key].trim())) throw new Error('The document contains no usable credential.');
  return { ...body, ...(force ? { force: true } : {}) };
}

// A wait that outlives the proxy it is waiting on can never succeed, and a grant
// with no end state leaves the row spinning, so both waits below end on a
// deadline. The proxies do NOT share one: codex and xai close at five minutes
// (CODEX_PROXY_TIMEOUT_MS and XAI_PROXY_TIMEOUT_MS, src/lib/oauth/utils/server.js
// :139 and :313) while trae, windsurf, devin and zed close at ten, from their
// own oauthTimeoutMs (600_000 for all four, read at server.js:535, :634, :719
// and :831). Cutting the long ones off at five abandoned sign-ins the proxy
// would still have accepted, so each wait carries its own flow's deadline.
const GRANT_DEADLINE_MS = 300_000;
const PROXY_SESSION_DEADLINE_MS = 600_000;
const GRANT_TIMED_OUT = "The sign-in did not finish in time. Close the sign-in window and start again.";

// The sign-in window is opened inside the caller's own event handler, BEFORE the
// first await. A window.open issued after an await has spent its transient user
// activation, which Firefox and Safari refuse outright, and a refused open used to
// leave the row waiting on a window that never existed.
//
// The `noopener` feature cannot be used here: it makes window.open return null,
// and this flow needs the handle to navigate the window once authorize answers.
// Severing the reference by hand costs nothing instead. The window is still on
// about:blank and same-origin at this point, so window.opener is writable, and
// clearing it means the PROVIDER origin never inherits a handle that can
// navigate this tab. The callback still reaches us: src/app/callback/page.js
// relays through BroadcastChannel and a localStorage record (page.js:39-41),
// both of which waitForCallback listens on, and the window.opener.postMessage
// it tries first is explicitly best-effort.
function openSignInWindow() {
  try {
    const win = window.open("about:blank", "tokenproxy_oauth", "width=600,height=700");
    try { if (win) win.opener = null; } catch { /* already cross-origin */ }
    return win;
  } catch { return null; }
}

// Separates "the browser refused to open a window" from "the person closed the
// blank window while authorize was in flight". The two need different sentences,
// because only one of them is fixed by allowing pop-ups.
function showAuthUrl(win, url) {
  if (!win) return "blocked";
  if (win.closed) return "closed";
  try { win.location.href = url; return "shown"; } catch { return "blocked"; }
}

// Poll /poll-status until done or error. The gateway clears the session on
// either, so a second read after "done" would say "unknown"; stop at the first.
async function pollStatus(provider, state, signal, deadlineMs = GRANT_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) return { status: "error", error: "Cancelled." };
    await new Promise((r) => setTimeout(r, 2000));
    const r = await call(`/api/oauth/${provider}/poll-status?state=${encodeURIComponent(state)}`);
    if (!r.ok) return { status: "error", error: r.body?.error || `HTTP ${r.status}` };
    if (r.body.status === "done" || r.body.status === "error") return r.body;
    if (Date.now() >= deadline) return { status: "error", error: GRANT_TIMED_OUT };
  }
}

// Wait for /callback to relay {code,state,token,error} through any of its
// three channels. Only same-origin postMessage is accepted.
function waitForCallback(expectedState, signal) {
  return new Promise((resolve) => {
    const seen = (data) => {
      if (!data || (expectedState && data.state && data.state !== expectedState)) return;
      cleanup();
      resolve(data);
    };
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "oauth_callback") seen(e.data.data);
    };
    const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("oauth_callback");
    if (bc) bc.onmessage = (e) => seen(e.data);
    const onStorage = (e) => {
      if (e.key !== "oauth_callback" || !e.newValue) return;
      try {
        const v = JSON.parse(e.newValue);
        if (v.timestamp && Date.now() - v.timestamp < 30000) seen(v);
      } catch { /* not ours */ }
    };
    const onAbort = () => { cleanup(); resolve(null); };
    const expiry = setTimeout(() => { cleanup(); resolve({ error: GRANT_TIMED_OUT }); }, GRANT_DEADLINE_MS);
    function cleanup() {
      clearTimeout(expiry);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      signal?.removeEventListener("abort", onAbort);
      if (bc) bc.close();
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    signal?.addEventListener("abort", onAbort);
  });
}

// Run one grant. `report(step)` receives short sentences for the dialog.
// Returns {ok, connection} | {ok:false, status, body} for refusal rendering.
// reauth: {reauthConnectionId, forceReauth} carried into exchange for rebinds.
export async function runGrant(provider, flowType, { report, signal, reauth, deviceHook, deviceOptions = {}, meta = {} } = {}) {
  if (reauth?.reauthConnectionId && requiresCredentialDocument(provider)) return { ok: false, status: 409, body: { error: 'Use a credential document to replace this account. The local callback flow creates a new account.' } };
  const say = report || (() => {});
  const origin = window.location.origin;
  // Opened now, while the caller's click is still the running task. Flows that
  // never navigate the browser (device code, pasted token) get no window.
  const win = WINDOWLESS_FLOWS.has(flowType) ? null : openSignInWindow();
  if (!win && !WINDOWLESS_FLOWS.has(flowType)) return { ok: false, status: 0, body: { error: POPUP_BLOCKED } };
  const stop = (result) => { try { win?.close(); } catch { /* already gone */ } return result; };

  if (flowType === "device_code") {
    const query = new URLSearchParams();
    for (const [field, parameter] of [['region', 'region'], ['startUrl', 'start_url'], ['authMethod', 'auth_method']]) {
      if (deviceOptions[field]) query.set(parameter, deviceOptions[field]);
    }
    const dc = await call(`/api/oauth/${provider}/device-code${query.size ? `?${query}` : ''}`);
    if (!dc.ok) return { ok: false, status: dc.status, body: dc.body };
    const { userCode, verificationUri, expiresIn } = dc.body;
    deviceHook?.({ userCode, verificationUri, expiresIn });
    say("Enter the code where the provider asks, then keep this open.");
    const interval = Math.max(2, dc.body.interval || 5) * 1000;
    for (;;) {
      if (signal?.aborted) return { ok: false, status: 0, body: { error: "Cancelled." } };
      await new Promise((r) => setTimeout(r, interval));
      if (signal?.aborted) return { ok: false, status: 0, body: { error: 'Cancelled.' } };
      const p = await call(`/api/oauth/${provider}/poll`, {
        method: "POST",
        body: { deviceCode: dc.body.deviceCode, codeVerifier: dc.body.codeVerifier, extraData: dc.body, ...(reauth || {}) },
      });
      if (p.ok && p.body.success) return { ok: true, connection: p.body.connection };
      if (!p.body?.pending) return { ok: false, status: p.status, body: { error: p.body?.errorDescription || p.body?.error || "The provider refused the sign-in." } };
    }
  }

  const redirectUri = `${origin}/callback`;
  const authorizeQuery = new URLSearchParams({ redirect_uri: redirectUri });
  for (const field of ['baseUrl', 'clientId']) if (meta[field]) authorizeQuery.set(field, meta[field]);
  const auth = await call(`/api/oauth/${provider}/authorize?${authorizeQuery}`);
  if (!auth.ok) return stop({ ok: false, status: auth.status, body: auth.body });
  const a = auth.body;
  // a.redirectUri is authoritative: a fixed-port provider overrides the one asked
  // for above with the loopback URI its own proxy listens on.

  if (PROXY_QUERY.includes(provider) && a.fixedPort) {
    // app_port is THIS dashboard's port, not the proxy's. The proxy uses it only for
    // its channel fallback, where it 302s the callback back to /callback here; naming
    // the proxy's own port there sends the redirect back into the socket that issued it.
    const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
    const q = new URLSearchParams({ app_port: appPort, state: a.state, code_verifier: a.codeVerifier, redirect_uri: a.redirectUri });
    const sp = await call(`/api/oauth/${provider}/start-proxy?${q}`);
    if (!sp.ok || !sp.body.success) return stop({ ok: false, status: sp.status, body: sp.body?.success === false ? { error: sp.body.error || "The local callback port could not be opened." } : sp.body });
    const shown = showAuthUrl(win, a.authUrl);
  if (shown !== "shown") return stop({ ok: false, status: 0, body: { error: shown === "closed" ? POPUP_CLOSED : POPUP_BLOCKED } });
    say("Finish the sign-in in the window that opened.");
    const done = await pollStatus(provider, a.state, signal);
    await call(`/api/oauth/${provider}/stop-proxy`).catch(() => {});
    if (done.status !== "done") return stop({ ok: false, status: 0, body: { error: done.error || "The provider refused the sign-in." } });
    return { ok: true, connection: { id: done.connectionId, provider, email: done.email } };
  }

  if (PROXY_SESSION.includes(provider)) {
    const sp = await call(`/api/oauth/${provider}/start-proxy`);
    if (!sp.ok || !sp.body.success) return stop({ ok: false, status: sp.status, body: sp.body?.success === false ? { error: sp.body.error || "The local callback port could not be opened." } : sp.body });
    const reg = await call(`/api/oauth/${provider}/register-session?state=${encodeURIComponent(a.state)}`, {
      method: "POST", body: { codeVerifier: a.codeVerifier, redirectUri: sp.body.callbackUrl },
    });
    if (!reg.ok || !reg.body.success) return stop({ ok: false, status: reg.status, body: { error: "The sign-in session could not be registered." } });
    const shown = showAuthUrl(win, a.authUrl);
  if (shown !== "shown") return stop({ ok: false, status: 0, body: { error: shown === "closed" ? POPUP_CLOSED : POPUP_BLOCKED } });
    say("Finish the sign-in in the window that opened.");
    const done = await pollStatus(provider, a.state, signal, PROXY_SESSION_DEADLINE_MS);
    await call(`/api/oauth/${provider}/stop-proxy`).catch(() => {});
    if (done.status !== "done") return stop({ ok: false, status: 0, body: { error: done.error || "The provider refused the sign-in." } });
    return { ok: true, connection: { id: done.connectionId, provider, email: done.email } };
  }

  // Plain browser redirect through /callback (authorization_code[_pkce]).
  const shown = showAuthUrl(win, a.authUrl);
  if (shown !== "shown") return stop({ ok: false, status: 0, body: { error: shown === "closed" ? POPUP_CLOSED : POPUP_BLOCKED } });
  say("Finish the sign-in in the window that opened.");
  const data = await waitForCallback(a.state, signal);
  if (!data) return stop({ ok: false, status: 0, body: { error: "Cancelled." } });
  if (data.error) return stop({ ok: false, status: 0, body: { error: data.error } });
  const ex = await call(`/api/oauth/${provider}/exchange`, {
    method: "POST",
    body: { code: data.code || data.token, redirectUri: a.redirectUri || redirectUri, codeVerifier: a.codeVerifier, state: data.state || a.state, ...(Object.keys(meta).length ? { meta } : {}), ...(reauth || {}) },
  });
  if (!ex.ok || !ex.body?.success) return stop({ ok: false, status: ex.status, body: ex.body });
  return { ok: true, connection: ex.body.connection };
}

// A pasted credential: a browser token (kimchi), a JWT (codex website), or a
// cursor state.vscdb pair. Routed to the matching import path.
export async function importPasted(provider, { token, machineId, reauth }) {
  if (provider === "cursor") {
    if (reauth?.reauthConnectionId) {
      const r = await call(`/api/providers/${encodeURIComponent(reauth.reauthConnectionId)}/reauth`, {
        method: 'POST', body: { accessToken: token, providerSpecificData: { machineId }, ...(reauth.forceReauth ? { force: true } : {}) },
      });
      return r.ok && r.body?.connection ? { ok: true, connection: r.body.connection } : { ok: false, status: r.status, body: r.body };
    }
    const r = await call("/api/oauth/cursor/import", { method: "POST", body: { accessToken: token, machineId } });
    return r.ok && r.body.success ? { ok: true, connection: r.body.connection } : { ok: false, status: r.status, body: r.body };
  }
  const r = await call(`/api/oauth/${provider}/exchange`, { method: "POST", body: { code: token, ...(reauth || {}) } });
  return r.ok && r.body?.success ? { ok: true, connection: r.body.connection } : { ok: false, status: r.status, body: r.body };
}
