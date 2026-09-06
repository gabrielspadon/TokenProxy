"use client";
import { useEffect } from "react";
import { Notice } from "@/shared/components/Notice";
import { useSearch } from "@/shared/hooks/useSearch";

const RELAY_KEY = "oauth_callback";
const RELAY_TTL_MS = 30_000;

export function parseCallback(search) {
  const q = new URLSearchParams(search);
  const data = {};
  for (const k of ["code", "state", "token", "error"]) if (q.get(k)) data[k] = q.get(k);
  if (data.error) delete data.code;
  return data;
}

// A provider error outranks a present code; a code or a token is a sign-in; nothing else arrived.
export function callbackOutcome(data) {
  if (data.error) return "error";
  if (data.code || data.token) return "done";
  return "empty";
}

// Relays the provider's answer to the window that opened this one, by three
// channels, then tells the person they can close it. The relay record lives
// 30 s and leaves with the page.
export default function CallbackPage() {
  const search = useSearch();
  const data = search === null ? null : parseCallback(search);
  const state = data === null ? "relaying" : callbackOutcome(data);
  const detail = search === null ? null : new URLSearchParams(search).get("error_description") || data.error || null;

  useEffect(() => {
    if (search === null) return;
    const data = parseCallback(search);
    const outcome = callbackOutcome(data);
    if (outcome === "empty") return;
    try { window.opener?.postMessage({ type: "oauth_callback", data }, window.location.origin); } catch { /* best effort */ }
    try { const bc = new BroadcastChannel("oauth_callback"); bc.postMessage(data); bc.close(); } catch { /* best effort */ }
    const drop = () => { try { localStorage.removeItem(RELAY_KEY); } catch { /* best effort */ } };
    try { localStorage.setItem(RELAY_KEY, JSON.stringify({ ...data, timestamp: Date.now(), expiresAt: Date.now() + RELAY_TTL_MS })); } catch { /* best effort */ }
    const ttl = setTimeout(drop, RELAY_TTL_MS);
    const close = outcome === "done" ? setTimeout(() => { try { window.close(); } catch { /* not ours to close */ } }, 1500) : null;
    window.addEventListener("pagehide", drop);
    return () => { clearTimeout(ttl); if (close) clearTimeout(close); window.removeEventListener("pagehide", drop); drop(); };
  }, [search]);

  return (
    <main className="login">
      <div className="login-card">
        <span className="brand" data-i18n-skip>TokenProxy</span>
        {state === "relaying" ? <p>Signing in</p> : null}
        {state === "done" ? <Notice tone="ok" title="Signed in." next="You can close this window." /> : null}
        {state === "error" ? <Notice tone="bad" title="The provider refused the sign-in." next="Close this window and start again from the connection." detail={detail} /> : null}
        {state === "empty" ? <Notice tone="warn" title="This window received nothing to relay." next="Start the sign-in again from the connection." /> : null}
        <a className="link-button" href="/dashboard">Return to the dashboard</a>
      </div>
    </main>
  );
}
