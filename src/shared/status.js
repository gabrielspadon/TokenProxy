// The connection status vocabulary of DESIGN.md §1, one word each.
export const TONE = { ok: "ok", healthy: "ok", degraded: "warn", unavailable: "bad", error: "bad", cooldown: "warn", drained: "warn", unqualified: "warn" };
export const WORDS = { ok: "Healthy", healthy: "Healthy", degraded: "Degraded", unavailable: "Unavailable", error: "Failing", cooldown: "Cooling down", drained: "Drained", unqualified: "Unqualified" };
export const AUTH = { oauth: "OAuth grant", apikey: "API key", api_key: "API key", access_token: "Pasted token", cookie: "Cookie", none: "No credential" };
