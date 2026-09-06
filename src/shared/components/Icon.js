// Inline reference into the self-hosted sprite at public/icons.svg.
// Decoration beside a text label, never the label itself.
export function Icon({ name, mirror }) {
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
