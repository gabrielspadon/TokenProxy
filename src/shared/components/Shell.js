"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/shared/nav";
import { useAuthStatus } from "@/store/authStatus";
import { usePoll } from "@/shared/hooks/usePoll";
import { LocaleSelect } from "./LocaleSelect";

function NavList({ pathname, onPick }) {
  return (
    <ul className="nav-list" role="list">
      {NAV.map((n) => {
        const current = n.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(n.href);
        return (
          <li key={n.href}>
            <Link href={n.href} prefetch={false} aria-current={current ? "page" : undefined} onClick={onPick}>{n.label}</Link>
          </li>
        );
      })}
    </ul>
  );
}

const METHOD = { Password: "Password sign-in", SAML: "SAML sign-in", OIDC: "OIDC sign-in" };

function Foot({ auth, version }) {
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  };
  const v = version.data;
  return (
    <div className="rail-foot">
      {v?.currentVersion ? (
        <span className="version" data-update={v.hasUpdate ? "true" : "false"}>
          {v.hasUpdate ? "Update available" : "Version"} <span className="id" data-i18n-skip>{v.currentVersion}</span>
          {v.hasUpdate && v.latestVersion ? <> <span>Latest</span> <span className="id" data-i18n-skip>{v.latestVersion}</span></> : null}
        </span>
      ) : null}
      {auth?.authenticated ? (
        <span className="caption">
          {auth.displayName && auth.loginMethod !== "Password" ? <span data-i18n-skip>{auth.displayName}</span> : null}
          {auth.loginMethod ? <> <span>{METHOD[auth.loginMethod] || auth.loginMethod}</span></> : null}
        </span>
      ) : auth && auth.requireLogin === false ? (
        <span className="caption">Sign-in is turned off</span>
      ) : null}
      <LocaleSelect />
      {auth?.authenticated ? <button type="button" className="button quiet" onClick={signOut}>Sign out</button> : null}
    </div>
  );
}

export function Shell({ children }) {
  const pathname = usePathname() || "/dashboard";
  const auth = useAuthStatus((s) => s.status);
  const load = useAuthStatus((s) => s.load);
  const version = usePoll("/api/version", 0);
  const dialog = useRef(null);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="shell">
      <header className="rail">
        <div className="rail-head">
          <Link className="brand" href="/dashboard" data-i18n-skip>TokenProxy</Link>
          <button type="button" className="button quiet menu-button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>Menu</button>
        </div>
        <nav aria-label="Sections"><NavList pathname={pathname} /></nav>
        <Foot auth={auth} version={version} />
      </header>
      <dialog className="nav-dialog" ref={dialog} aria-label="Sections">
        <div className="rail-head">
          <span className="brand" data-i18n-skip>TokenProxy</span>
          <button type="button" className="button quiet" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <nav aria-label="Sections" style={{ marginBlockStart: 16 }}><NavList pathname={pathname} onPick={() => dialog.current?.close()} /></nav>
        <Foot auth={auth} version={version} />
      </dialog>
      <main className="content" id="main">{children}</main>
    </div>
  );
}
