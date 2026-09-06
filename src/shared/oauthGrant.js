"use client";

// One OAuth grant, from authorize to a saved connection, for every flow the
// gateway speaks. The credential itself never passes through this module in
// the browser-redirect flows; only codes, states, and the gateway's own
// connection summary {id, provider, email, displayName} do.
import { call } from "@/shared/api";

const PROXY_QUERY = ["codex", "xai"]; // start-proxy?app_port=&state=&code_verifier=&redirect_uri=
const PROXY_SESSION = ["trae", "windsurf", "zed", "devin"]; // start-proxy then register-session

// Poll /poll-status until done or error. The gateway clears the session on
// either, so a second read after "done" would say "unknown"; stop at the first.
async function pollStatus(provider, state, signal) {
  for (;;) {
    if (signal?.aborted) return { status: "error", error: "Cancelled." };
    await new Promise((r) => setTimeout(r, 2000));
    const r = await call(`/api/oauth/${provider}/poll-status?state=${encodeURIComponent(state)}`);
    if (!r.ok) return { status: "error", error: r.body?.error || `HTTP ${r.status}` };
    if (r.body.status === "done" || r.body.status === "error") return r.body;
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
    function cleanup() {
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
export async function runGrant(provider, flowType, { report, signal, reauth, deviceHook } = {}) {
  const say = report || (() => {});
  const origin = window.location.origin;

  if (flowType === "device_code") {
    const dc = await call(`/api/oauth/${provider}/device-code`);
    if (!dc.ok) return { ok: false, status: dc.status, body: dc.body };
    deviceHook?.(dc.body); // show userCode + verificationUri in the dialog
    say("Enter the code where the provider asks, then keep this open.");
    const interval = Math.max(2, dc.body.interval || 5) * 1000;
    for (;;) {
      if (signal?.aborted) return { ok: false, status: 0, body: { error: "Cancelled." } };
      await new Promise((r) => setTimeout(r, interval));
      const p = await call(`/api/oauth/${provider}/poll`, {
        method: "POST",
        body: { deviceCode: dc.body.deviceCode, codeVerifier: dc.body.codeVerifier, ...(reauth || {}) },
      });
      if (p.ok && p.body.success) return { ok: true, connection: p.body.connection };
      if (!p.body?.pending) return { ok: false, status: p.status, body: { error: p.body?.errorDescription || p.body?.error || "The provider refused the sign-in." } };
    }
  }

  const redirectUri = `${origin}/callback`;
  const auth = await call(`/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
  if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };
  const a = auth.body;

  if (PROXY_QUERY.includes(provider) && a.fixedPort) {
    const q = new URLSearchParams({ app_port: String(a.fixedPort), state: a.state, code_verifier: a.codeVerifier, redirect_uri: a.redirectUri });
    const sp = await call(`/api/oauth/${provider}/start-proxy?${q}`);
    if (!sp.ok || !sp.body.success) return { ok: false, status: sp.status, body: sp.body?.success === false ? { error: sp.body.error || "The local callback port could not be opened." } : sp.body };
    window.open(a.authUrl, "_blank", "noopener");
    say("Finish the sign-in in the window that opened.");
    const done = await pollStatus(provider, a.state, signal);
    await call(`/api/oauth/${provider}/stop-proxy`).catch(() => {});
    if (done.status !== "done") return { ok: false, status: 0, body: { error: done.error || "The provider refused the sign-in." } };
    return { ok: true, connection: { id: done.connectionId, provider, email: done.email } };
  }

  if (PROXY_SESSION.includes(provider)) {
    const sp = await call(`/api/oauth/${provider}/start-proxy`);
    if (!sp.ok || !sp.body.success) return { ok: false, status: sp.status, body: sp.body?.success === false ? { error: sp.body.error || "The local callback port could not be opened." } : sp.body };
    const reg = await call(`/api/oauth/${provider}/register-session?state=${encodeURIComponent(a.state)}`, {
      method: "POST", body: { codeVerifier: a.codeVerifier, redirectUri: sp.body.callbackUrl },
    });
    if (!reg.ok || !reg.body.success) return { ok: false, status: reg.status, body: { error: "The sign-in session could not be registered." } };
    window.open(a.authUrl, "_blank", "noopener");
    say("Finish the sign-in in the window that opened.");
    const done = await pollStatus(provider, a.state, signal);
    await call(`/api/oauth/${provider}/stop-proxy`).catch(() => {});
    if (done.status !== "done") return { ok: false, status: 0, body: { error: done.error || "The provider refused the sign-in." } };
    return { ok: true, connection: { id: done.connectionId, provider, email: done.email } };
  }

  // Plain browser redirect through /callback (authorization_code[_pkce]).
  window.open(a.authUrl, "_blank", "noopener");
  say("Finish the sign-in in the window that opened.");
  const data = await waitForCallback(a.state, signal);
  if (!data) return { ok: false, status: 0, body: { error: "Cancelled." } };
  if (data.error) return { ok: false, status: 0, body: { error: data.error } };
  const ex = await call(`/api/oauth/${provider}/exchange`, {
    method: "POST",
    body: { code: data.code || data.token, redirectUri: a.redirectUri || redirectUri, codeVerifier: a.codeVerifier, state: data.state || a.state, ...(reauth || {}) },
  });
  if (!ex.ok || !ex.body?.success) return { ok: false, status: ex.status, body: ex.body };
  return { ok: true, connection: ex.body.connection };
}

// A pasted credential: a browser token (kimchi), a JWT (codex website), or a
// cursor state.vscdb pair. Routed to the matching import path.
export async function importPasted(provider, { token, machineId, reauth }) {
  if (provider === "cursor") {
    const r = await call("/api/oauth/cursor/import", { method: "POST", body: { accessToken: token, machineId } });
    return r.ok && r.body.success ? { ok: true, connection: r.body.connection } : { ok: false, status: r.status, body: r.body };
  }
  const r = await call(`/api/oauth/${provider}/exchange`, { method: "POST", body: { code: token, ...(reauth || {}) } });
  return r.ok && r.body?.success ? { ok: true, connection: r.body.connection } : { ok: false, status: r.status, body: r.body };
}
