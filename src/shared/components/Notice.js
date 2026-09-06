// A sentence with a tone. Never a toast that says "error".
export function Notice({ tone = "info", title, next, detail, children }) {
  return (
    <div className="notice" data-tone={tone} role={tone === "bad" ? "alert" : "status"}>
      {title ? <h3>{title}</h3> : null}
      {next ? <p className="next">{next}</p> : null}
      {detail ? <p className="caption" data-i18n-skip>{String(detail)}</p> : null}
      {children}
    </div>
  );
}
