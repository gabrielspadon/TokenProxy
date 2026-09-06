"use client";
import { fmtRelative, fmtTime, isEpoch } from "@/shared/format";

// The time axis. A fixed now-line at the start, marks for moments ahead of
// it. `horizonMs` is shared by every ruler on a screen so marks line up.
export function Ruler({ horizonMs, marks = [], now, showScale = false }) {
  const pos = (iso) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - now) / horizonMs) * 100));
  return (
    <div className="ruler" aria-hidden="true">
      {marks.filter((m) => !isEpoch(m.at)).map((m, i) => (
        <span key={i} className={m.soft ? "mark soft" : "mark"} style={{ insetInlineStart: `${pos(m.at)}%` }} title={fmtTime(m.at)} />
      ))}
      {showScale ? (
        <>
          <span className="scale now" data-i18n-skip>{fmtTime(new Date(now).toISOString())}</span>
          <span className="scale end" style={{ insetInlineStart: "100%" }} data-i18n-skip>{fmtRelative(new Date(now + horizonMs).toISOString(), now)}</span>
        </>
      ) : null}
    </div>
  );
}
