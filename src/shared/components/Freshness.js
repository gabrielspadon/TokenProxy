"use client";
import { useEffect, useState } from "react";
import { fmtRelative, fmtTime } from "@/shared/format";

const LABEL = { live: "Live", stale: "Stale since", reconnecting: "Reconnecting", connecting: "Connecting" };

// Visible state of one stream or poll: live, stale since, reconnecting.
export function Freshness({ status, lastDataAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const when = lastDataAt ? new Date(lastDataAt).toISOString() : null;
  return (
    <span className="fresh" data-state={status} role="status">
      {LABEL[status] || status}
      {status === "stale" && when ? <span data-i18n-skip>{fmtTime(when)}</span> : null}
      {status === "live" && when && now - lastDataAt >= 5000 ? <span data-i18n-skip>{fmtRelative(when, now)}</span> : null}
    </span>
  );
}
