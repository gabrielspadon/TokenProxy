"use client";
import { useSyncExternalStore } from "react";
import { LOCALES, LOCALE_NAMES } from "@/i18n/config";

const none = () => () => {};
const readLang = () => document.documentElement.lang || "en";
const serverLang = () => "en";

// The server sets lang and dir from the cookie, so a change reloads the page.
export function LocaleSelect() {
  const current = useSyncExternalStore(none, readLang, serverLang);
  const change = async (e) => {
    const locale = e.target.value;
    const res = await fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale }) });
    if (res.ok) window.location.reload();
  };
  return (
    <label className="field">
      <span>Language</span>
      <select className="select" value={current} onChange={change}>
        {LOCALES.map((l) => (
          <option key={l} value={l}>{LOCALE_NAMES[l] || l}</option>
        ))}
      </select>
    </label>
  );
}
