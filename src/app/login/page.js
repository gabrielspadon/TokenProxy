"use client";
import { useEffect, useState } from "react";
import { Notice } from "@/shared/components/Notice";
import { useSearch } from "@/shared/hooks/useSearch";
import { refusal } from "@/shared/refusal";
import { fmtUnit } from "@/shared/format";
import { Brand } from '@/shared/components/Brand';

const START_ERRORS = {
  oidc_not_configured: "OIDC is not configured on this gateway.",
  saml_not_configured: "SAML is not configured on this gateway.",
  oidc_start_failed: "OIDC sign-in could not start.",
  saml_start_failed: "SAML sign-in could not start.",
};

function loginRefusal(status, body) {
  if (status === 401) {
    return { tone: "warn", title: "That password is not right.", attempts: body?.remainingBeforeLock };
  }
  if (status === 429) {
    return { tone: "bad", title: "Too many failed attempts from this address.", retryAfter: body?.retryAfter ?? 30 };
  }
  if (status === 403 && body?.mustChangePassword) {
    return { tone: "bad", title: "The default password is still set, so remote sign-in is refused.", next: "Change the password from the machine that runs the gateway, or set INITIAL_PASSWORD before starting it." };
  }
  if (status === 403 && /tunnel/i.test(body?.error || "")) {
    return { tone: "bad", title: "Dashboard access through the tunnel is turned off.", next: "Open the dashboard from the machine that runs the gateway, or turn tunnel access on there." };
  }
  if (status === 403 && /disabled/i.test(body?.error || "")) {
    return { tone: "warn", title: "Password sign-in is turned off.", next: "Use single sign-on below.", sso: /SAML/i.test(body.error) ? "saml" : "oidc" };
  }
  if (status === 500) return { tone: "bad", title: "The gateway could not check the password.", next: "Try again in a moment.", detail: body?.error };
  return refusal(status, body);
}

export default function LoginPage() {
  const [auth, setAuth] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [left, setLeft] = useState(0);

  const search = useSearch();
  const startCode = search ? new URLSearchParams(search).get("error") : null;
  const startError = !startCode ? null : START_ERRORS[startCode] ? { title: START_ERRORS[startCode] } : { title: "Single sign-on failed.", detail: startCode };

  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" }).then((r) => r.json()).then(setAuth).catch(() => setAuth({ authMode: "password", hasPassword: true }));
  }, []);

  useEffect(() => {
    if (!left) return undefined;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        window.location.assign("/dashboard");
        return;
      }
      const r = loginRefusal(res.status, body);
      setResult(r);
      if (r.retryAfter) setLeft(r.retryAfter);
    } catch (err) {
      setResult(refusal(0, { error: err.message, code: "network" }));
    } finally {
      setBusy(false);
    }
  };

  const mode = auth?.authMode || "password";
  const showSaml = mode === "saml" || (mode === "sso" && auth?.ssoType === "saml") || auth?.samlConfigured || result?.sso === "saml";
  const showOidc = mode === "oidc" || (mode === "sso" && auth?.ssoType === "oidc") || auth?.oidcConfigured || result?.sso === "oidc";
  const showPassword = auth === null || mode === "password" || result?.sso === undefined && !(mode === "saml" || mode === "oidc" || mode === "sso");
  const locked = left > 0;

  return (
    <main className="login">
      <div className="login-card">
        <span className="brand"><Brand /></span>
        <h1>Sign in</h1>
        <p className="caption">Your models, connections, and context. Sign in to the gateway control room.</p>
        {startError ? <Notice tone="bad" title={startError.title} detail={startError.detail} /> : null}
        {showPassword ? (
          <form onSubmit={submit}>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={locked} />
            </label>
            <button className="button" type="submit" disabled={busy || locked}>{busy ? "Signing in" : "Sign in"}</button>
          </form>
        ) : null}
        {result ? (
          <Notice tone={result.tone} title={result.title} next={result.next} detail={result.detail}>
            {result.attempts !== undefined && result.attempts !== null ? (
              <dl className="facts"><dt>Attempts left before lockout</dt><dd>{result.attempts}</dd></dl>
            ) : null}
            {result.retryAfter ? (
              <dl className="facts"><dt>Try again in</dt><dd>{fmtUnit(left, "second")}</dd></dl>
            ) : null}
          </Notice>
        ) : null}
        {showSaml ? <a className="button quiet" href="/api/auth/saml/start">{auth?.samlLoginLabel ? <span>{auth.samlLoginLabel}</span> : "Sign in with SAML"}</a> : null}
        {showOidc ? <a className="button quiet" href="/api/auth/oidc/start">{auth?.oidcLoginLabel ? <span>{auth.oidcLoginLabel}</span> : "Sign in with OIDC"}</a> : null}
      </div>
    </main>
  );
}
