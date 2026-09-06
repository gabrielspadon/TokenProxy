// The information architecture from docs/design/plan.md, in reading order.
export const NAV = [
  { href: '/dashboard', label: 'Overview', icon: 'i-now', group: 'Observe' },
  { href: '/dashboard/context', label: 'Context', icon: 'i-context', group: 'Observe' },
  { href: '/dashboard/connections', label: 'Connections', icon: 'i-connections' },
  { href: '/dashboard/sessions', label: 'Sessions', icon: 'i-sessions' },
  { href: '/dashboard/network', label: 'Network', icon: 'i-network' },
  { href: '/dashboard/models', label: 'Models', icon: 'i-models' },
  { href: '/dashboard/keys', label: 'Keys', icon: 'i-keys' },
  { href: '/dashboard/usage', label: 'Usage', icon: 'i-usage' },
  { href: '/dashboard/shaping', label: 'Shaping', icon: 'i-shaping' },
  { href: '/dashboard/translation', label: 'Translation', icon: 'i-translation' },
  { href: '/dashboard/tools', label: 'Tools', icon: 'i-tools' },
  { href: '/dashboard/remote', label: 'Remote', icon: 'i-remote' },
  { href: '/dashboard/notifications', label: 'Notifications', icon: 'i-notifications' },
  { href: '/dashboard/access', label: 'Access', icon: 'i-access' },
  { href: '/dashboard/system', label: 'System', icon: 'i-system' },
];

export const NAV_GROUPS = [
  {
    label: 'Observe',
    paths: ['/dashboard', '/dashboard/context', '/dashboard/usage', '/dashboard/sessions'],
  },
  {
    label: 'Route & optimize',
    paths: [
      '/dashboard/connections',
      '/dashboard/models',
      '/dashboard/shaping',
      '/dashboard/translation',
      '/dashboard/tools',
    ],
  },
  {
    label: 'Workspace',
    paths: [
      '/dashboard/keys',
      '/dashboard/network',
      '/dashboard/remote',
      '/dashboard/notifications',
      '/dashboard/access',
      '/dashboard/system',
    ],
  },
];
