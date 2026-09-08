'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ActionIcon,
  AppShell,
  Burger,
  Button,
  Divider,
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
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { NAV, NAV_GROUPS } from '@/shared/nav';
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [query, setQuery] = useState('');
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
  const isCapacity = ['/dashboard', '/dashboard/context', '/dashboard/usage'].includes(pathname);
  return (
    <AppShell
      padding={0}
      header={{ height: 52 }}
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
              size="lg"
              aria-label="Find a control"
              onClick={() => setSearchOpen(true)}
            >
              <Icon name="i-search" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Workspace preferences">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label="Workspace preferences"
              className={styles.desktopPreferences}
              onClick={() => setPreferencesOpen(true)}
            >
              <Icon name="i-access" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className={styles.navbar} inert={!desktopNavigation && !mobileOpen ? true : undefined}>
        <Button
          hiddenFrom="md"
          variant="subtle"
          color="gray"
          my="sm"
          onClick={() => {
            setMobileOpen(false);
            setPreferencesOpen(true);
          }}
        >
          Workspace preferences
        </Button>
        <ScrollArea className={styles.navScroll}>
          <nav aria-label="Sections">
            {NAV_GROUPS.map((group, index) => (
              <div className={styles.navGroup} key={group.label}>
                <Text className={styles.navGroupLabel}>
                  {index === 0 ? 'Analysis' : group.label}
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
        <div className={styles.navBottom}>
          <ObservationControls />
        </div>
      </AppShell.Navbar>
      <AppShell.Main className={styles.main}>
        <div id="main" tabIndex={-1} className={isCapacity ? styles.lensMain : styles.legacyMain}>
          {children}
        </div>
      </AppShell.Main>
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
      <Modal
        opened={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        title="Workspace preferences"
        centered
      >
        <Stack>
          <Text>
            {auth?.authenticated
              ? `${auth.loginMethod || 'Password'} sign-in`
              : auth?.requireLogin === false
                ? 'Sign-in is turned off'
                : 'Operator account'}
          </Text>
          <div>
            <Text id="appearance-label" fw={500} mb={8}>Appearance</Text>
            <SegmentedControl fullWidth aria-labelledby="appearance-label" value={colorScheme} onChange={setColorScheme}
              data={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'System' }]} />
            <Text size="sm" c="dimmed" mt={8}>Saved for this browser. System follows your device appearance.</Text>
          </div>
          <Divider />
          {auth?.authenticated && (
            <Button
              variant="light"
              loading={signingOut}
              disabled={snapshot?.isolated}
              onClick={signOut}
              leftSection={<Icon name="i-signout" />}
            >
              Sign out
            </Button>
          )}
          {signOutError && <Text role="alert" c="red">{signOutError}</Text>}
          {snapshot && (
            <Text size="sm" c="dimmed">
              {snapshot.kind === 'synthetic-fixture'
                ? 'Only fixture-scoped changes are available in this isolated runtime.'
                : 'Operational changes are disabled in this private snapshot.'}
            </Text>
          )}
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
