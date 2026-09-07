"use client";
import { useId, useState, useSyncExternalStore } from "react";
import { LOCALES, LOCALE_NAMES } from "@/i18n/config";

const none = () => () => {};
const readLang = () => document.documentElement.lang || "en";
const serverLang = () => "en";

// The server sets lang and dir from the cookie, so a change reloads the page.
export function LocaleSelect() {
  const current = useSyncExternalStore(none, readLang, serverLang);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  const change = async (e) => {
    const locale = e.target.value;
    setPending(true);
    setError('');
    try {
      const res = await fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale }) });
      if (!res.ok) throw new Error('Locale save refused');
      window.location.reload();
    } catch {
      setError('Language could not be saved. Your current language remains active.');
      setPending(false);
    }
  };
  return (
    <label className="field">
      <span>Language</span>
      <select className="select" value={current} onChange={change} disabled={pending} aria-busy={pending} aria-describedby={error ? errorId : undefined}>
        {LOCALES.map((l) => (
          <option key={l} value={l}>{LOCALE_NAMES[l] || l}</option>
        ))}
      </select>
      {pending && <span role="status">Saving language…</span>}
      {error && <span id={errorId} role="alert">{error}</span>}
    </label>
  );
}
