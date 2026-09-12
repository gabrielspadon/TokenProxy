// Destinations retain stable deep links across the analytical workspace.
export const NAV = [
  { href: '/dashboard', label: 'Capacity', icon: 'i-now', group: 'Analysis' },
  { href: '/dashboard/context', label: 'Context', icon: 'i-context', group: 'Observe' },
  { href: '/dashboard/connections', label: 'Connections', icon: 'i-connections' },
  { href: '/dashboard/sessions', label: 'Sessions', icon: 'i-sessions' },
  { href: '/dashboard/network', label: 'Network', icon: 'i-network' },
  { href: '/dashboard/models', label: 'Models', icon: 'i-models' },
  { href: '/dashboard/model-context', label: 'Context limits', icon: 'i-context' },
  { href: '/dashboard/keys', label: 'Keys', icon: 'i-keys' },
  { href: '/dashboard/usage', label: 'Economics', icon: 'i-usage' },
  { href: '/dashboard/shaping', label: 'Token savings', icon: 'i-shaping' },
  { href: '/dashboard/compatibility', label: 'Compatibility', icon: 'i-compatibility' },
  { href: '/dashboard/tools', label: 'Tools', icon: 'i-tools' },
  { href: '/dashboard/notifications', label: 'Notifications', icon: 'i-notifications' },
  { href: '/dashboard/access', label: 'Access', icon: 'i-access' },
  { href: '/dashboard/system', label: 'System', icon: 'i-system' },
  { href: '/dashboard/operations', label: 'Operation history', icon: 'i-sessions' },
  { href: '/dashboard/requests', label: 'Request workbench', icon: 'i-request' },
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
      '/dashboard/model-context',
      '/dashboard/shaping',
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

// Every supported destination is always in the rail. The groups order them;
// they never gate one away, so no destination depends on a stored preference to
// be reachable. Direct links and authorization are independent of this view.
export function navigationGroups() {
  return NAV_GROUPS;
}
