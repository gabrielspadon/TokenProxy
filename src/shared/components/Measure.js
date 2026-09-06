// One measure from /api/system/state. value null with a reason is "not
// reported", never zero. `render` formats a non-null value.
export function Measure({ label, measure, render, big = false }) {
  const m = measure || null;
  const missing = !m || m.value === null || m.value === undefined;
  return (
    <div className={big ? "measure big" : "measure"}>
      <span className="label">{label}</span>
      {missing ? (
        <>
          <span className="value unreported">Not reported</span>
          {m?.unavailable ? <details className="why"><summary>Why</summary><p data-i18n-skip>{m.unavailable}</p></details> : null}
        </>
      ) : (
        <span className="value" data-i18n-skip>{render(m.value)}</span>
      )}
    </div>
  );
}
