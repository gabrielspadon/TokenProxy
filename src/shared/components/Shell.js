'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV, NAV_GROUPS } from '@/shared/nav';
import { Brand } from './Brand';
import { useAuthStatus } from '@/store/authStatus';
import { usePoll } from '@/shared/hooks/usePoll';
import { LocaleSelect } from './LocaleSelect';
import { Icon } from './Icon';
import { Strap } from './Strap';

function NavList({ pathname, onPick }) {
  return (
    <div className="nav-groups">
      {NAV_GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <span className="nav-group-label">{group.label}</span>
          <ul className="nav-list" role="list">
            {group.paths
              .map((href) => NAV.find((n) => n.href === href))
              .filter(Boolean)
              .map((n) => {
                const current =
                  n.href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(n.href);
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      prefetch={false}
                      aria-current={current ? 'page' : undefined}
                      onClick={onPick}
                    >
                      <Icon name={n.icon} />
                      {n.label}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

const SEARCH_TERMS = {
  '/dashboard': 'health traffic overview live requests',
  '/dashboard/context': 'cache compaction conversation project context tokens',
  '/dashboard/connections': 'provider account quota limit oauth credential',
  '/dashboard/models': 'model routing combo fallback',
  '/dashboard/shaping': 'cache saver compression token optimization memory risk',
  '/dashboard/keys': 'endpoint api key credential',
  '/dashboard/usage': 'cost spend price statistics tokens requests latency',
  '/dashboard/access': 'security password login sso',
  '/dashboard/network': 'proxy pools dns network',
  '/dashboard/system': 'settings logs backup restore',
};
const matchesControl = (n, query) =>
  `${n.label} ${SEARCH_TERMS[n.href] || ''}`.toLowerCase().includes(query.trim().toLowerCase());

const METHOD = { Password: 'Password sign-in', SAML: 'SAML sign-in', OIDC: 'OIDC sign-in' };

function Foot({ auth, version }) {
  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  };
  const v = version.data;
  return (
    <div className="rail-foot">
      {v?.currentVersion ? (
        <span className="version" data-update={v.hasUpdate ? 'true' : 'false'}>
          {v.hasUpdate ? 'Update available' : 'Version'}{' '}
          <span className="id" data-i18n-skip>
            {v.currentVersion}
          </span>
          {v.hasUpdate && v.latestVersion ? (
            <>
              {' '}
              <span>Latest</span>{' '}
              <span className="id" data-i18n-skip>
                {v.latestVersion}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
      {auth?.authenticated ? (
        <span className="caption">
          {auth.displayName && auth.loginMethod !== 'Password' ? (
            <span data-i18n-skip>{auth.displayName}</span>
          ) : null}
          {auth.loginMethod ? (
            <>
              {' '}
              <span>{METHOD[auth.loginMethod] || auth.loginMethod}</span>
            </>
          ) : null}
        </span>
      ) : auth && auth.requireLogin === false ? (
        <span className="caption">Sign-in is turned off</span>
      ) : null}
      <LocaleSelect />
      {auth?.authenticated ? (
        <button type="button" className="button quiet" onClick={signOut}>
          <Icon name="i-signout" mirror />
          Sign out
        </button>
      ) : null}
    </div>
  );
}

export function Shell({ children }) {
  const pathname = usePathname() || '/dashboard';
  const auth = useAuthStatus((s) => s.status);
  const load = useAuthStatus((s) => s.load);
  const version = usePoll('/api/version', 0);
  const dialog = useRef(null);
  const searchDialog = useRef(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const open = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        searchDialog.current?.showModal();
      }
    };
    window.addEventListener('keydown', open);
    return () => window.removeEventListener('keydown', open);
  }, []);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="rail">
        <div className="rail-head">
          <Link className="brand" href="/dashboard" data-i18n-skip>
            <Brand />
          </Link>
          <button
            type="button"
            className="button quiet menu-button"
            aria-haspopup="dialog"
            onClick={() => dialog.current?.showModal()}
          >
            <Icon name="i-menu" />
            Menu
          </button>
        </div>
        <button
          className="nav-search"
          type="button"
          onClick={() => searchDialog.current?.showModal()}
        >
          <Icon name="i-search" />
          <span>Find a control</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Sections">
          <NavList pathname={pathname} />
        </nav>
        <Foot auth={auth} version={version} />
      </header>
      <Strap />
      <dialog className="nav-dialog" ref={dialog} aria-label="Sections">
        <div className="rail-head">
          <span className="brand" data-i18n-skip>
            <Brand />
          </span>
          <button type="button" className="button quiet" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        <nav aria-label="Sections" style={{ marginBlockStart: 16 }}>
          <NavList pathname={pathname} onPick={() => dialog.current?.close()} />
        </nav>
        <Foot auth={auth} version={version} />
      </dialog>
      <dialog className="command-dialog" ref={searchDialog} aria-label="Find a control">
        <div className="command-head">
          <Icon name="i-search" />
          <input
            className="input"
            aria-label="Find a control"
            placeholder="Search pages and controls…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="button quiet"
            onClick={() => searchDialog.current?.close()}
            aria-label="Close search"
          >
            <Icon name="i-close" />
          </button>
        </div>
        <div className="command-results">
          {NAV.filter((n) => matchesControl(n, query)).map((n) => (
            <Link
              href={n.href}
              key={n.href}
              onClick={() => {
                searchDialog.current?.close();
                setQuery('');
              }}
            >
              <Icon name={n.icon} />
              {n.label}
              <Icon name="i-right" />
            </Link>
          ))}
          {!NAV.some((n) => matchesControl(n, query)) ? (
            <p className="empty">No matching controls.</p>
          ) : null}
        </div>
      </dialog>
      <main className="content" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
