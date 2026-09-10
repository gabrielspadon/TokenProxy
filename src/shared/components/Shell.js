'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ActionIcon,
  AppShell,
  Burger,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useHotkeys, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { NAV, navigationGroups } from '@/shared/nav';
import { useAuthStatus } from '@/store/authStatus';
import { Icon } from './Icon';
import { WorkspaceProvider, useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { ObservationControls } from '@/shared/workspace/ObservationControls';
import styles from '@/shared/workspace/workspace.module.css';

const SEARCH_TERMS = {
  '/dashboard': 'capacity account quota reset health headroom allocation',
  '/dashboard/context': 'cache compaction conversation project agent context tokens',
  '/dashboard/connections': 'provider account quota oauth credential',
  '/dashboard/models': 'model routing combo fallback eligibility',
  '/dashboard/shaping': 'cache saver compression token optimization memory risk',
  '/dashboard/compatibility': 'translator fixture format conversion run evidence',
  '/dashboard/keys': 'endpoint api key credential',
  '/dashboard/usage': 'economics cost spend price statistics tokens requests latency',
};
const LABELS = { '/dashboard': 'Capacity', '/dashboard/usage': 'Economics' };
const lensName = (item) => LABELS[item.href] || item.label;
const SEARCH_DESTINATIONS = [
  ...NAV,
  { href: '/dashboard/usage?tool=pricing', label: 'Model pricing', icon: 'i-usage', terms: 'rates cache input output reset price' },
  { href: '/dashboard/usage?tool=budgets', label: 'Budget reservations', icon: 'i-usage', terms: 'exposure reconciliation release cost ceilings' },
];

export function SnapshotNotice() {
  const { snapshot } = useWorkspace();
  if (!snapshot) return null;
  const synthetic = snapshot.kind === 'synthetic-fixture';
  const captured = snapshot.capturedAt
    ? new Date(snapshot.capturedAt).toLocaleString('en-GB', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : 'Historical';
  return (
    <Tooltip
      label={
        synthetic
          ? 'Synthetic test records in an isolated runtime. These are not production observations.'
          : 'A private copy of recorded data. Outbound calls and operational changes are disabled. Persisted pending statuses are not live requests.'
      }
    >
      <span className={styles.snapshot}>
        <span className={styles.snapshotDot} />
        <span className={styles.snapshotIdentity}>
          <span>{synthetic ? 'Synthetic fixture' : 'Snapshot'}</span>
          {snapshot.capturedAt && <time dateTime={snapshot.capturedAt} dir="ltr">{captured} UTC</time>}
        </span>
        <span className={styles.isolation}>Isolated</span>
      </span>
    </Tooltip>
  );
}

function WorkspaceShell({ children }) {
  const pathname = usePathname() || '/dashboard';
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [navigationMode, setNavigationMode] = useLocalStorage({ key: 'tokenproxy.navigation-mode', defaultValue: 'everyday' });
  const desktopNavigation = useMediaQuery('(min-width: 62em)');
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const auth = useAuthStatus((state) => state.status);
  const load = useAuthStatus((state) => state.load);
  const { snapshot, accounts } = useWorkspace();
  useEffect(() => {
    load();
  }, [load]);
  useHotkeys([['mod+k', () => setSearchOpen(true)]]);
  const signOut = async () => {
    setSigningOut(true);
    setSignOutError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign-out was not confirmed. You can retry.');
      window.location.assign('/login');
    } catch {
      setSignOutError('Sign-out was not confirmed. Your current workspace remains open.');
      setSigningOut(false);
    }
  };
  const normalizedQuery = query.trim().toLowerCase();
  const destinations = SEARCH_DESTINATIONS.filter((item) =>
    `${lensName(item)} ${item.terms || ''} ${SEARCH_TERMS[item.href] || ''}`.toLowerCase().includes(normalizedQuery)
  );
  const accountResults = normalizedQuery ? (accounts || []).filter((account) =>
    `${account.displayName || account.name || ''} ${account.provider || ''} ${account.connectionId || ''}`.toLowerCase().includes(normalizedQuery)
  ).slice(0, 12) : [];
  // Every dashboard page now composes the lens heading and the board itself.
  const isCapacity = pathname.startsWith('/dashboard');
  return (
    <AppShell
      padding={0}
      header={{ height: 44 }}
      navbar={{ width: 208, breakpoint: 'md', collapsed: { mobile: !mobileOpen } }}
      className={styles.shell}
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <AppShell.Header className={styles.header}>
        <Group h="100%" wrap="nowrap" className={styles.headerContent}>
          <Burger
            opened={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
            hiddenFrom="md"
            size="sm"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          />
          <Link href="/dashboard" className={styles.wordmark}>
            TokenProxy<span className={styles.wordmarkPoint}>.</span>
          </Link>
          {!snapshot && <Text className={styles.workspaceLabel}>Local gateway</Text>}
          <div className={styles.headerSpacer} />
          <SnapshotNotice />
          <Tooltip label="Find a page or control (⌘ K)">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Find a control"
              onClick={() => setSearchOpen(true)}
            >
              <Icon name="i-search" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className={styles.navbar} inert={!desktopNavigation && !mobileOpen ? true : undefined}>
        <ScrollArea className={styles.navScroll}>
          <nav aria-label="Sections">
            <div className={styles.navigationMode}>
              <SegmentedControl fullWidth size="xs" aria-label="Navigation view" value={navigationMode === 'advanced' ? 'advanced' : 'everyday'} onChange={setNavigationMode}
                data={[{ value: 'everyday', label: 'Everyday' }, { value: 'advanced', label: 'Advanced' }]} />
            </div>
            {navigationGroups(navigationMode, pathname).map((group) => (
              <div className={styles.navGroup} key={group.label}>
                <Text className={styles.navGroupLabel}>
                  {group.label}
                </Text>
                {group.paths
                  .map((href) => NAV.find((item) => item.href === href))
                  .filter(Boolean)
                  .map((item) => (
                    <NavLink
                      key={item.href}
                      component={Link}
                      href={item.href}
                      prefetch={false}
                      label={lensName(item)}
                      leftSection={<Icon name={item.icon} />}
                      active={pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`))}
                      aria-current={pathname === item.href ? 'page' : undefined}
                      onClick={() => setMobileOpen(false)}
                      className={styles.navItem}
                    />
                  ))}
              </div>
            ))}
          </nav>
        </ScrollArea>
        {/* Preferences apply in place in the rail, beside the update behavior. */}
        <div className={styles.navBottom}>
          <ObservationControls />
          <div className={styles.railSetting} role="group" aria-label="Workspace preferences">
            <div className={styles.railHead}>
              <span id="appearance-label">Appearance</span>
            </div>
            <Tooltip
              label="Saved for this browser. System follows your device appearance."
              multiline
              w={240}
              position="right-end"
              events={{ hover: true, focus: true, touch: false }}
            >
              <SegmentedControl fullWidth size="xs" aria-labelledby="appearance-label" value={colorScheme} onChange={setColorScheme}
                data={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'System' }]} />
            </Tooltip>
            <div className={styles.railAccount}>
              <span>
                {auth?.authenticated
                  ? `${auth.loginMethod || 'Password'} sign-in`
                  : auth?.requireLogin === false
                    ? 'Sign-in is turned off'
                    : 'Operator account'}
              </span>
              {auth?.authenticated && (
                <Tooltip label="Sign out">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Sign out"
                    loading={signingOut}
                    disabled={snapshot?.isolated}
                    onClick={signOut}
                  >
                    <Icon name="i-signout" />
                  </ActionIcon>
                </Tooltip>
              )}
            </div>
            {signOutError && <p role="alert" className={styles.railAlert}>{signOutError}</p>}
            {snapshot && (
              <p className={styles.railNote}>
                {snapshot.kind === 'synthetic-fixture'
                  ? 'Only fixture-scoped changes are available in this isolated runtime.'
                  : 'Operational changes are disabled in this private snapshot.'}
              </p>
            )}
          </div>
        </div>
      </AppShell.Navbar>
      <AppShell.Main className={styles.main}>
        <div id="main" tabIndex={-1} className={isCapacity ? styles.lensMain : styles.legacyMain}>
          {children}
        </div>
      </AppShell.Main>
      {/* Search stays a layer: it is the one persistent entry plus its keyboard
          shortcut that docs/design/COMPACT-WORKSPACE-20260907.md keeps. */}
      <Modal
        opened={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="Find a control"
        centered
        size="lg"
      >
        <TextInput
          data-autofocus
          aria-label="Find a control"
          placeholder="Search capacity, cache, quota, models…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          leftSection={<Icon name="i-search" />}
          size="md"
        />
        <Text size="sm" c="dimmed" mt="sm">Find workspace destinations, settings, and observed accounts. Opening a result does not run a provider test.</Text>
        <Stack gap={4} mt="md">
          {destinations.length > 0 && <Text className={styles.searchSection}>Destinations and settings</Text>}
          {destinations.map((item) => (
            <NavLink
              component={Link}
              href={item.href}
              label={lensName(item)}
              leftSection={<Icon name={item.icon} />}
              key={item.href}
              onClick={() => { setSearchOpen(false); setMobileOpen(false); }}
            />
          ))}
          {accountResults.length > 0 && <Text className={styles.searchSection}>Observed accounts</Text>}
          {accountResults.map((account) => <NavLink
            key={account.connectionId} component={Link}
            href={`/dashboard/connections/${encodeURIComponent(account.connectionId)}`}
            label={account.displayName || account.name || account.connectionId} description={account.provider}
            leftSection={<Icon name="i-connections" />} onClick={() => { setSearchOpen(false); setMobileOpen(false); }}
          />)}
          {!destinations.length && !accountResults.length && <div className={styles.searchEmpty} role="status">
            No matching destination or observed account. Try a provider name, quota, pricing, routing, or a shorter search.
          </div>}
        </Stack>
      </Modal>
    </AppShell>
  );
}
export function Shell({ children }) {
  return (
    <WorkspaceProvider>
      <WorkspaceShell>{children}</WorkspaceShell>
    </WorkspaceProvider>
  );
}
