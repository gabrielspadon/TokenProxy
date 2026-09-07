// Cost display, in the reader's own number conventions (#2976).
//
// Every figure the dashboard shows is USD: `open-sse/providers/pricing.js` holds
// USD-per-million-token rates and `calculateCostFromTokens` never leaves that
// unit. The dashboard then printed a bare "$", which reads as the local dollar
// wherever one exists and as nothing recognisable in the rest of the world.
//
// What this deliberately does NOT do is convert at a rate baked into the source.
// A hardcoded 7.2 prints a figure nobody can reconcile against a bill and is
// wrong the day after it is written, and these numbers are already labelled an
// estimate — a second invented factor on top makes them unusable. So conversion
// is opt-in and the rate is the caller's: pass one and the amount is converted
// and labelled in the locale's currency, pass none and the USD amount is
// formatted with the reader's own grouping and decimal marks (zh-CN sees
// "US$0.20", not an ambiguous "$0.20").

// Currency conventions for callers that explicitly supply a formatting locale.
// Anything absent — en, es, ar, bn, ur, where the tag names a language spoken
// across several currency zones — stays in USD rather than guessing a country.
const LOCALE_CURRENCY = {
  "zh-CN": "CNY", "zh-TW": "TWD", ja: "JPY", ko: "KRW", "pt-BR": "BRL",
  vi: "VND", ru: "RUB", pl: "PLN", cs: "CZK", tr: "TRY", uk: "UAH",
  th: "THB", id: "IDR", hi: "INR", he: "ILS", hu: "HUF", ro: "RON",
  sv: "SEK", da: "DKK", no: "NOK", tl: "PHP", km: "KHR", fa: "IRR",
  de: "EUR", fr: "EUR", it: "EUR", nl: "EUR", fi: "EUR", el: "EUR", "pt-PT": "EUR",
};

export const BASE_CURRENCY = "USD";

/** The currency a locale's reader expects, or USD when the tag does not pin one. */
export function currencyForLocale(locale) {
  return LOCALE_CURRENCY[locale] || BASE_CURRENCY;
}

/**
 * Format a USD cost for one reader.
 *
 * @param {number} usd       amount in USD (null/NaN is treated as zero, which is
 *                           what every call site already did with `n || 0`)
 * @param {object} [options]
 * @param {string} [options.locale="en"]  Explicit BCP-47 formatting tag
 * @param {number} [options.decimals=2]   fraction digits, both min and max, so a
 *                                        per-call cost can keep 4 the way the
 *                                        chart does today
 * @param {number} [options.rate=null]    USD → local units. Omitted, absent or
 *                                        not a positive finite number means no
 *                                        conversion and the amount stays USD.
 * @returns {string}
 */
export function formatCost(usd, { locale = "en", decimals = 2, rate = null } = {}) {
  const base = Number.isFinite(usd) ? usd : 0;
  const target = currencyForLocale(locale);
  const usable = target !== BASE_CURRENCY && Number.isFinite(rate) && rate > 0;
  const amount = usable ? base * rate : base;
  const currency = usable ? target : BASE_CURRENCY;

  const opts = {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };
  try {
    return new Intl.NumberFormat(locale, opts).format(amount);
  } catch {
    // An unusable formatting tag falls back to English number conventions.
    return new Intl.NumberFormat("en", opts).format(amount);
  }
}
