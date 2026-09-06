"use client";
import { useState } from "react";
import Link from "next/link";
import { usePoll } from "@/shared/hooks/usePoll";
import { Confirm } from "@/shared/components/Confirm";
import { Freshness } from "@/shared/components/Freshness";
import { Notice } from "@/shared/components/Notice";
import { call } from "@/shared/api";
import { refusal } from "@/shared/refusal";
import { fmtUnit } from "@/shared/format";
import "./styles.css";

const METHOD = { Password: "Password sign-in", SAML: "SAML sign-in", OIDC: "OIDC sign-in" };
const EMPTY_PASSWORD = { current: "", next: "", repeat: "" };
const EMPTY_OIDC = { oidcIssuerUrl: "", oidcClientId: "", oidcClientSecret: "", oidcScopes: "", oidcLoginLabel: "" };
const EMPTY_SAML = { samlEntryPoint: "", samlIssuer: "", samlCert: "", samlLoginLabel: "" };

function pollFresh(p) {
  if (p.loading) return "connecting";
  if (p.error && p.goodAt) return "stale";
  if (p.error) return "reconnecting";
  return "live";
}

// A password change answers 401 only because the current password was wrong;
// the session that carried the request was valid or the guard would have
// refused it earlier. Say that instead of "your session has ended".
function passwordRefusal(status, body) {
  if (status === 401) return { tone: "warn", title: "That is not the current password.", next: "Type the password this gateway uses now, then try again." };
  return refusal(status, body);
}

function Unreported({ why }) {
  return (
    <>
      <span className="unreported">Not reported</span>
      <details className="why"><summary>Why</summary><p>{why}</p></details>
    </>
  );
}

function Secret({ set }) {
  return <span className="status" data-tone={set ? "ok" : "warn"}>{set ? "Set" : "Not set"}</span>;
}

export default function AccessPage() {
  const auth = usePoll("/api/auth/status", 15000);
  const settings = usePoll("/api/settings", 30000);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const [pw, setPw] = useState(EMPTY_PASSWORD);
  const [oidc, setOidc] = useState(EMPTY_OIDC);
  const [saml, setSaml] = useState(EMPTY_SAML);
  const [method, setMethod] = useState(null);
  const [probe, setProbe] = useState(null);

  const a = auth.data;
  const s = settings.data;
  const federated = a?.authMode === "sso" || a?.authMode === "oidc" || a?.authMode === "saml";
  const protocol = federated ? a?.ssoType || "oidc" : "password";
  const chosen = method ?? protocol;
  const requireLogin = a ? a.requireLogin : null;

  // Every secret this screen holds is write-only, so the fields empty the moment
  // a submit is answered, refused or not. Nothing typed here survives the reply.
  const forget = () => { setPw(EMPTY_PASSWORD); setOidc(EMPTY_OIDC); setSaml(EMPTY_SAML); };
  const close = () => { setOpen(null); setFailure(null); forget(); };

  const run = async (url, body, method_, after) => {
    setBusy(true);
    setFailure(null);
    const res = await call(url, { method: method_ || "PATCH", body });
    setBusy(false);
    forget();
    if (!res.ok) {
      setFailure(body.newPassword ? passwordRefusal(res.status, res.body) : refusal(res.status, res.body));
      return;
    }
    setOpen(null);
    setDone(after);
    auth.refresh();
    settings.refresh();
  };

  const test = async () => {
    setBusy(true);
    setProbe(null);
    const res = await call(chosen === "saml" ? "/api/auth/saml/test" : "/api/auth/oidc/test", { method: "POST", body: {} });
    setBusy(false);
    setProbe(res.ok ? { tone: "ok", title: "The provider accepted this configuration.", detail: res.body?.message } : refusal(res.status, res.body));
  };

  const mismatch = pw.next !== "" && pw.repeat !== "" && pw.next !== pw.repeat;

  return (
    <>
      <div className="screen-head">
        <h1>Access</h1>
        <Freshness status={pollFresh(auth)} lastDataAt={auth.goodAt} />
      </div>

      {done ? <Notice tone="ok" title={done} /> : null}

      <section aria-labelledby="h-now">
        <h2 id="h-now">How sign-in works now</h2>
        {auth.error && !a ? <Notice {...refusal(auth.status, auth.error)} /> : null}
        {!a && auth.loading ? <p className="skeleton">Reading</p> : null}
        {a ? (
          <dl className="facts access-facts">
            <dt>Signing in</dt>
            <dd><span className="status" data-tone={requireLogin ? "ok" : "bad"}>{requireLogin ? "Required" : "Not required"}</span></dd>
            <dt>Method in force</dt>
            <dd>{METHOD[federated ? (protocol === "saml" ? "SAML" : "OIDC") : "Password"]}</dd>
            <dt>You</dt>
            <dd>{a.authenticated ? <><span data-i18n-skip>{a.displayName}</span> <span>{METHOD[a.loginMethod] || a.loginMethod}</span></> : <span className="status" data-tone="warn">Not signed in</span>}</dd>
            <dt>Session lifetime</dt>
            <dd>A session lasts 24 hours from the moment it is issued, and is not extended by use.</dd>
            <dt>Session issued and expires</dt>
            <dd><Unreported why="The session lives in a cookie the browser will not hand to a script, and no route reports when it was issued." /></dd>
          </dl>
        ) : null}
        {a && !a.hasPassword ? (
          <Notice tone="bad" title="This installation is still on its default password." next="Change it below. Until it changes, a correct sign-in from anywhere but this machine is refused, because the default is public knowledge." />
        ) : null}
      </section>

      <section aria-labelledby="h-password">
        <h2 id="h-password">Password</h2>
        <dl className="facts access-facts">
          <dt>Stored password</dt>
          <dd>{a ? <Secret set={a.hasPassword} /> : <span className="skeleton">Reading</span>}</dd>
        </dl>
        <p className="caption">A stored password is never readable back, here or anywhere else.</p>
        <div className="access-actions">
          <button type="button" className="button" onClick={() => { setPw(EMPTY_PASSWORD); setOpen("password"); }}>Change password</button>
          <button type="button" className="button quiet" onClick={() => setOpen("reset")}>Reset to the default</button>
        </div>
      </section>

      <section aria-labelledby="h-sso">
        <h2 id="h-sso">Single sign-on</h2>
        {settings.error && !s ? <Notice {...refusal(settings.status, settings.error)} /> : null}
        <fieldset className="segmented">
          <legend>Sign-in method</legend>
          {[["password", "Password"], ["oidc", "OIDC"], ["saml", "SAML"]].map(([id, label]) => (
            <label key={id}>
              <input type="radio" name="method" value={id} checked={chosen === id} onChange={() => setMethod(id)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {chosen !== protocol ? (
          <div className="access-actions">
            <button type="button" className="button" onClick={() => setOpen("method")}>Change method</button>
            <button type="button" className="button quiet" onClick={() => setMethod(null)}>Cancel</button>
          </div>
        ) : null}

        {chosen === "password" ? (
          <p className="caption">Sign-in uses the password above. Nothing is asked of an outside provider.</p>
        ) : chosen === "oidc" ? (
          <dl className="facts access-facts">
            <dt>Configured</dt>
            <dd>{a ? <span className="status" data-tone={a.oidcConfigured ? "ok" : "warn"}>{a.oidcConfigured ? "Yes" : "No"}</span> : <span className="skeleton">Reading</span>}</dd>
            <dt>Provider address</dt>
            <dd>{s?.oidcIssuerUrl ? <span className="id" data-i18n-skip>{s.oidcIssuerUrl}</span> : <span className="empty">Not configured</span>}</dd>
            <dt>Client identity</dt>
            <dd>{s?.oidcClientId ? <span className="id" data-i18n-skip>{s.oidcClientId}</span> : <span className="empty">Not configured</span>}</dd>
            <dt>Client secret</dt>
            <dd><Secret set={!!a?.oidcConfigured} /></dd>
            <dt>Requested scopes</dt>
            <dd>{s?.oidcScopes ? <span className="id" data-i18n-skip>{s.oidcScopes}</span> : <span className="empty">Not configured</span>}</dd>
            <dt>Label on the sign-in action</dt>
            <dd data-i18n-skip>{a?.oidcLoginLabel}</dd>
          </dl>
        ) : (
          <dl className="facts access-facts">
            <dt>Configured</dt>
            <dd>{a ? <span className="status" data-tone={a.samlConfigured ? "ok" : "warn"}>{a.samlConfigured ? "Yes" : "No"}</span> : <span className="skeleton">Reading</span>}</dd>
            <dt>Provider address</dt>
            <dd>{s?.samlEntryPoint ? <span className="id" data-i18n-skip>{s.samlEntryPoint}</span> : <span className="empty">Not configured</span>}</dd>
            <dt>Our identity to the provider</dt>
            <dd>{s?.samlIssuer ? <span className="id" data-i18n-skip>{s.samlIssuer}</span> : <span className="empty">Not configured</span>}</dd>
            <dt>Signing certificate</dt>
            <dd><Secret set={!!a?.samlConfigured} /></dd>
            <dt>Asserted name and address</dt>
            <dd>{s ? <><span className="id" data-i18n-skip>{s.samlAttributeName}</span> <span className="id" data-i18n-skip>{s.samlAttributeEmail}</span></> : <span className="skeleton">Reading</span>}</dd>
            <dt>Label on the sign-in action</dt>
            <dd data-i18n-skip>{a?.samlLoginLabel}</dd>
            <dt>Document for the provider</dt>
            <dd><a href="/api/auth/saml/metadata">Open the document this gateway publishes</a></dd>
          </dl>
        )}

        {chosen !== "password" ? (
          <>
            <div className="access-actions">
              <button type="button" className="button" onClick={() => { setOidc(EMPTY_OIDC); setSaml(EMPTY_SAML); setOpen("sso"); }}>Configure</button>
              <button type="button" className="button quiet" onClick={test} disabled={busy}>Test without saving</button>
              <button type="button" className="button quiet" onClick={() => setOpen("clear")}>Clear the configuration</button>
            </div>
            {probe ? <Notice tone={probe.tone} title={probe.title} next={probe.next} detail={probe.detail} /> : null}
            <p className="caption">A test contacts the provider and commits nothing. A stored client secret cannot be cleared from here, only replaced.</p>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-open">
        <h2 id="h-open">What stays protected when sign-in is off</h2>
        <p>Turning sign-in off is the widest decision on this screen. Anyone who can reach this port then reads the dashboard and changes most settings with no password at all.</p>
        <p>Four things keep asking for a session either way, and they are the ones that end or replace the installation.</p>
        <ul className="bullets">
          <li>Shutting the gateway down.</li>
          <li>Exporting or importing the whole database.</li>
          <li>Installing an update, and the shutdown that comes with it.</li>
          <li>Every change under the operator interface, which also has to come from the machine that runs the gateway.</li>
        </ul>
        <p>A rejected request changes nothing. State reads exactly as it did the moment before the attempt.</p>
        <dl className="facts access-facts">
          <dt>Client keys for inference</dt>
          <dd>{s ? <span className="status" data-tone={s.requireApiKey ? "ok" : "warn"}>{s.requireApiKey ? "Required" : "Not required"}</span> : <span className="skeleton">Reading</span>} <Link href="/dashboard/keys" prefetch={false}>Keys</Link></dd>
          <dt>Sign-in over the remote transport</dt>
          <dd>{s ? <span className="status" data-tone={s.tunnelDashboardAccess ? "warn" : "ok"}>{s.tunnelDashboardAccess ? "Allowed" : "Refused"}</span> : <span className="skeleton">Reading</span>} <Link href="/dashboard/remote" prefetch={false}>Remote</Link></dd>
        </dl>
        <p className="caption">An inference key never reaches anything on this screen. A caller holding only one is told it holds the wrong kind of credential, not that it holds none.</p>
        <div className="access-actions">
          {a ? <button type="button" className={requireLogin ? "button danger" : "button"} onClick={() => setOpen(requireLogin ? "off" : "on")}>{requireLogin ? "Turn sign-in off" : "Turn sign-in on"}</button> : null}
        </div>
      </section>

      <section aria-labelledby="h-lockout">
        <h2 id="h-lockout">Lockout rules</h2>
        <p>Five wrong passwords from one address lock that address out. Each further lockout waits longer.</p>
        <dl className="facts access-facts">
          <dt>First lockout</dt>
          <dd data-i18n-skip>{fmtUnit(30, "second")}</dd>
          <dt>Second</dt>
          <dd data-i18n-skip>{fmtUnit(2, "minute")}</dd>
          <dt>Third</dt>
          <dd data-i18n-skip>{fmtUnit(10, "minute")}</dd>
          <dt>Fourth and after</dt>
          <dd data-i18n-skip>{fmtUnit(30, "minute")}</dd>
          <dt>Failures are forgotten after</dt>
          <dd data-i18n-skip>{fmtUnit(1, "hour")}</dd>
          <dt>Attempts left, and time left on a lockout</dt>
          <dd><Unreported why="Only the sign-in screen is told, and only the address that is failing. No route reports the counter to an operator." /></dd>
        </dl>
        <p>A failed single sign-on counts against the same five. The counter lives in memory, so restarting the gateway clears every lockout.</p>
      </section>

      <Confirm
        open={open === "password"} title="Change password" verb="Change password" busy={busy} refusal={failure}
        requires={a?.hasPassword ? "The password this gateway uses now." : "Nothing. No password is stored yet."}
        changes="Every sign-in after this one uses the new password. Sessions already issued keep working until they expire."
        undo="None. The old password cannot be recovered."
        irreversible
        onClose={close}
        onConfirm={() => { if (!mismatch && pw.next) run("/api/settings", { currentPassword: pw.current, newPassword: pw.next }, "PATCH", "Password changed."); }}
      >
        <div className="access-fields">
          {a?.hasPassword ? (
            <label className="field"><span>Current password</span>
              <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            </label>
          ) : null}
          <label className="field"><span>New password</span>
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          </label>
          <label className="field"><span>New password again</span>
            <input className="input" type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} required />
          </label>
          {mismatch ? <Notice tone="warn" title="The two new passwords are not the same." next="Type the same password twice, so a typo cannot lock you out." /> : null}
        </div>
      </Confirm>

      <Confirm
        open={open === "reset"} title="Reset to the default" verb="Reset to the default" busy={busy} refusal={failure}
        requires="A request from the machine that runs the gateway, or the command-line token."
        changes="The stored password is cleared. The next sign-in uses the default, and remote sign-in is refused again until a new password is set."
        undo="None. The old password cannot be recovered."
        irreversible
        onClose={close}
        onConfirm={() => run("/api/auth/reset-password", {}, "POST", "Password reset to the default. Set a new one now.")}
      />

      <Confirm
        open={open === "off"} title="Turn sign-in off" verb="Turn sign-in off" busy={busy} refusal={failure}
        requires="A session, which you have."
        changes="Anyone who can reach this port reads the dashboard and changes most settings without a password. Shutdown, database export and import, and update still ask for a session, and every change under the operator interface stays bound to this machine."
        undo="Turn it back on here. While it is off, anyone who reaches the port can turn it on or off too."
        irreversible={false}
        onClose={close}
        onConfirm={() => run("/api/settings", { requireLogin: false }, "PATCH", "Sign-in turned off.")}
      />

      <Confirm
        open={open === "on"} title="Turn sign-in on" verb="Turn sign-in on" busy={busy} refusal={failure}
        requires="Nothing. Sign-in is off, so this screen is open to anyone who reached the port."
        changes="Every dashboard route asks for a session again. Sign in with the password above."
        undo="Turn it back off here, once signed in."
        irreversible={false}
        onClose={close}
        onConfirm={() => run("/api/settings", { requireLogin: true }, "PATCH", "Sign-in turned on.")}
      />

      <Confirm
        open={open === "method"} title="Change the sign-in method" verb="Change method" busy={busy} refusal={failure}
        requires="A session, and a provider that is already configured if you are moving to one."
        changes="The sign-in screen offers the method you chose. Password sign-in is refused only once the chosen provider is fully configured, so an unfinished provider still leaves the password working."
        undo="Change it back here."
        irreversible={false}
        onClose={() => { setMethod(null); close(); }}
        onConfirm={() => run("/api/settings", chosen === "password" ? { authMode: "password" } : { authMode: "sso", ssoType: chosen }, "PATCH", "Sign-in method changed.")}
      />

      <Confirm
        open={open === "sso"} title="Configure single sign-on" verb="Save configuration" busy={busy} refusal={failure}
        requires="A session, and the values the identity provider issued for this gateway."
        changes="The gateway trusts that provider for sign-in. A secret or certificate you type here is stored and never shown again."
        undo="Clear the configuration here, or type new values over it."
        irreversible={false}
        onClose={close}
        onConfirm={() => run("/api/settings", chosen === "saml" ? saml : oidc, "PATCH", "Single sign-on saved.")}
      >
        <div className="access-fields">
          {chosen === "saml" ? (
            <>
              <label className="field"><span>Provider address</span>
                <input className="input" type="url" value={saml.samlEntryPoint} onChange={(e) => setSaml({ ...saml, samlEntryPoint: e.target.value })} />
              </label>
              <label className="field"><span>Our identity to the provider</span>
                <input className="input" type="text" value={saml.samlIssuer} onChange={(e) => setSaml({ ...saml, samlIssuer: e.target.value })} />
              </label>
              <label className="field"><span>Signing certificate</span>
                <input className="input" type="password" autoComplete="new-password" value={saml.samlCert} onChange={(e) => setSaml({ ...saml, samlCert: e.target.value })} />
              </label>
              <label className="field"><span>Label on the sign-in action</span>
                <input className="input" type="text" value={saml.samlLoginLabel} onChange={(e) => setSaml({ ...saml, samlLoginLabel: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label className="field"><span>Provider address</span>
                <input className="input" type="url" value={oidc.oidcIssuerUrl} onChange={(e) => setOidc({ ...oidc, oidcIssuerUrl: e.target.value })} />
              </label>
              <label className="field"><span>Client identity</span>
                <input className="input" type="text" value={oidc.oidcClientId} onChange={(e) => setOidc({ ...oidc, oidcClientId: e.target.value })} />
              </label>
              <label className="field"><span>Client secret</span>
                <input className="input" type="password" autoComplete="new-password" value={oidc.oidcClientSecret} onChange={(e) => setOidc({ ...oidc, oidcClientSecret: e.target.value })} />
              </label>
              <label className="field"><span>Requested scopes</span>
                <input className="input" type="text" value={oidc.oidcScopes} onChange={(e) => setOidc({ ...oidc, oidcScopes: e.target.value })} />
              </label>
              <label className="field"><span>Label on the sign-in action</span>
                <input className="input" type="text" value={oidc.oidcLoginLabel} onChange={(e) => setOidc({ ...oidc, oidcLoginLabel: e.target.value })} />
              </label>
            </>
          )}
        </div>
      </Confirm>

      <Confirm
        open={open === "clear"} title="Clear the configuration" verb="Clear the configuration" busy={busy} refusal={failure}
        requires="A session."
        changes="The provider address and identity are removed, so the gateway no longer offers this sign-in. A stored client secret is not removed by this, because the gateway refuses to store an empty one."
        undo="Type the values again here. The provider itself is untouched."
        irreversible={false}
        onClose={close}
        onConfirm={() => run("/api/settings", chosen === "saml" ? { samlEntryPoint: "", samlCert: "" } : { oidcIssuerUrl: "", oidcClientId: "" }, "PATCH", "Single sign-on cleared.")}
      />
    </>
  );
}
