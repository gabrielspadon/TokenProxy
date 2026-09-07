// Destinations retain stable deep links across the analytical workspace.
export const NAV = [
  { href: '/dashboard', label: 'Capacity', icon: 'i-now', group: 'Analysis' },
  { href: '/dashboard/context', label: 'Context', icon: 'i-context', group: 'Observe' },
  { href: '/dashboard/connections', label: 'Connections', icon: 'i-connections' },
  { href: '/dashboard/sessions', label: 'Sessions', icon: 'i-sessions' },
  { href: '/dashboard/network', label: 'Network', icon: 'i-network' },
  { href: '/dashboard/models', label: 'Models', icon: 'i-models' },
  { href: '/dashboard/keys', label: 'Keys', icon: 'i-keys' },
  { href: '/dashboard/usage', label: 'Economics', icon: 'i-usage' },
  { href: '/dashboard/shaping', label: 'Token savings', icon: 'i-shaping' },
  { href: '/dashboard/translation', label: 'Translation', icon: 'i-translation' },
  { href: '/dashboard/compatibility', label: 'Compatibility', icon: 'i-compatibility' },
  { href: '/dashboard/tools', label: 'Tools', icon: 'i-tools' },
  { href: '/dashboard/remote', label: 'Remote', icon: 'i-remote' },
  { href: '/dashboard/notifications', label: 'Notifications', icon: 'i-notifications' },
  { href: '/dashboard/access', label: 'Access', icon: 'i-access' },
  { href: '/dashboard/system', label: 'System', icon: 'i-system' },
  { href: '/dashboard/operations', label: 'Operation history', icon: 'i-sessions' },
  { href: '/dashboard/requests', label: 'Request workbench', icon: 'i-translation' },
];

export const NAV_GROUPS = [
  {
    label: 'Analysis',
    paths: ['/dashboard', '/dashboard/context', '/dashboard/usage', '/dashboard/sessions'],
  },
  {
    label: 'Routing',
    paths: [
      '/dashboard/models',
      '/dashboard/shaping',
      '/dashboard/translation',
      '/dashboard/compatibility',
      '/dashboard/requests',
    ],
  },
  {
    label: 'Connections',
    paths: [
      '/dashboard/connections',
      '/dashboard/keys',
      '/dashboard/network',
      '/dashboard/remote',
      '/dashboard/tools',
    ],
  },
  {
    label: 'Operations',
    paths: [
      '/dashboard/operations',
      '/dashboard/notifications',
      '/dashboard/access',
      '/dashboard/system',
    ],
  },
];
