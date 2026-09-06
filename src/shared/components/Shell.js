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
  Kbd,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { NAV, NAV_GROUPS } from '@/shared/nav';
import { useAuthStatus } from '@/store/authStatus';
import { LocaleSelect } from './LocaleSelect';
import { Icon } from './Icon';
import { WorkspaceProvider, useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import styles from '@/shared/workspace/workspace.module.css';

const SEARCH_TERMS = {
  '/dashboard': 'capacity account quota reset health headroom allocation',
  '/dashboard/context': 'cache compaction conversation project agent context tokens',
  '/dashboard/connections': 'provider account quota oauth credential',
  '/dashboard/models': 'model routing combo fallback eligibility',
  '/dashboard/shaping': 'cache saver compression token optimization memory risk',
  '/dashboard/keys': 'endpoint api key credential',
  '/dashboard/usage': 'economics cost spend price statistics tokens requests latency',
};
const LABELS = { '/dashboard': 'Capacity', '/dashboard/usage': 'Economics' };
const lensName = (item) => LABELS[item.href] || item.label;

export function SnapshotNotice() {
  const { snapshot } = useWorkspace();
  if (!snapshot) return null;
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
    <Tooltip label="A private copy of recorded data. Outbound calls and operational changes are disabled. Persisted pending statuses are not live requests.">
      <span className={styles.snapshot}>
        <span className={styles.snapshotDot} />
        Snapshot {captured}
        {snapshot.capturedAt ? ' UTC' : ''}
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
  const auth = useAuthStatus((state) => state.status);
  const load = useAuthStatus((state) => state.load);
  const { snapshot } = useWorkspace();
  useEffect(() => {
    load();
  }, [load]);
  useHotkeys([['mod+k', () => setSearchOpen(true)]]);
  const signOut = async () => {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) window.location.assign('/login');
  };
  const isCapacity = ['/dashboard', '/dashboard/context', '/dashboard/usage'].includes(pathname);
  return (
    <AppShell
      padding={0}
      header={{ height: 52 }}
      navbar={{ width: 194, breakpoint: 'md', collapsed: { mobile: !mobileOpen } }}
      className={styles.shell}
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <AppShell.Header className={styles.header}>
        <Group gap="sm" h="100%" px={18} wrap="nowrap">
          <Burger
            opened={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
            hiddenFrom="md"
            size="sm"
            aria-label="Open navigation"
          />
          <Link href="/dashboard" className={styles.wordmark} data-i18n-skip>
            TokenProxy<span className={styles.wordmarkPoint}>.</span>
          </Link>
          <span className={styles.headerDivider} />
          <Text className={styles.workspaceLabel}>Workspace</Text>
          <div className={styles.headerSpacer} />
          <SnapshotNotice />
          <Tooltip label="Find a page or control">
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
          <Tooltip label="Workspace account and language">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label="Workspace account and language"
              onClick={() => setPreferencesOpen(true)}
            >
              <Icon name="i-access" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className={styles.navbar}>
        <div className={styles.navIntro}>
          <span className={styles.workspaceOrb}>
            <Icon name="i-models" />
          </span>
          <div>
            <strong>Gateway workspace</strong>
            <span>{snapshot ? 'Recorded environment' : 'Local environment'}</span>
          </div>
        </div>
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
                      active={pathname === item.href}
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
          <Button
            fullWidth
            variant="transparent"
            color="gray"
            leftSection={<Icon name="i-search" />}
            rightSection={<Kbd size="xs">⌘ K</Kbd>}
            onClick={() => setSearchOpen(true)}
          >
            Find a control
          </Button>
          <Text size="xs">{snapshot ? 'Private historical preview' : 'Operator workspace'}</Text>
        </div>
      </AppShell.Navbar>
      <AppShell.Main className={styles.main}>
        <main id="main" tabIndex={-1} className={isCapacity ? styles.lensMain : styles.legacyMain}>
          {children}
        </main>
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
        <Stack gap={4} mt="md">
          {NAV.filter((item) =>
            `${lensName(item)} ${SEARCH_TERMS[item.href] || ''}`
              .toLowerCase()
              .includes(query.toLowerCase())
          ).map((item) => (
            <NavLink
              component={Link}
              href={item.href}
              label={lensName(item)}
              leftSection={<Icon name={item.icon} />}
              key={item.href}
              onClick={() => setSearchOpen(false)}
            />
          ))}
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
          <LocaleSelect />
          <Divider />
          {auth?.authenticated && (
            <Button
              variant="light"
              disabled={snapshot?.isolated}
              onClick={signOut}
              leftSection={<Icon name="i-signout" />}
            >
              Sign out
            </Button>
          )}
          {snapshot && (
            <Text size="sm" c="dimmed">
              Operational changes are disabled in this private snapshot.
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
