// Inline reference into the self-hosted sprite at public/icons.svg.
// Decoration beside a text label, never the label itself.
const GLYPHS = {
  'i-now': 'dashboard',
  'i-context': 'account_tree',
  'i-connections': 'hub',
  'i-sessions': 'group',
  'i-network': 'lan',
  'i-models': 'layers',
  'i-keys': 'key',
  'i-usage': 'monitoring',
  'i-shaping': 'tune',
  'i-translation': 'translate',
  'i-compatibility': 'checklist',
  'i-tools': 'build',
  'i-remote': 'computer',
  'i-notifications': 'chat',
  'i-access': 'shield',
  'i-system': 'settings',
  'i-signout': 'logout',
  'i-search': 'search',
  'i-menu': 'menu',
  'i-close': 'close',
  'i-add': 'add',
  'i-copy': 'content_copy',
  'i-refresh': 'refresh',
  'i-right': 'arrow_forward',
  'i-check': 'check',
  'i-pause': 'pause_circle',
  'i-play': 'play_arrow',
};
export function Icon({ name, mirror }) {
  if (GLYPHS[name])
    return (
      <span
        className="icon material-symbol"
        aria-hidden="true"
        data-mirror={mirror ? 'true' : undefined}
      >
        {GLYPHS[name]}
      </span>
    );
  return (
    <svg
      className="icon"
      aria-hidden="true"
      focusable="false"
      data-mirror={mirror ? 'true' : undefined}
    >
      <use href={`/icons.svg#${name}`} />
    </svg>
  );
}
