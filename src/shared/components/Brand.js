export function Brand({ compact = false }) {
  return (
    <span className="brand-lockup">
      <span className="brand-symbol" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path
            d="M8 8 16 16 24 7M16 16 24 25M16 16 6 25"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="8" cy="8" r="3" />
          <circle cx="24" cy="7" r="3" />
          <circle cx="16" cy="16" r="4" />
          <circle cx="24" cy="25" r="3" />
          <circle cx="6" cy="25" r="3" />
        </svg>
      </span>
      {!compact ? (
        <span>
          Token<span className="brand-proxy">Proxy</span>
          <small>Gateway control room</small>
        </span>
      ) : null}
    </span>
  );
}
