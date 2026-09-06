import { connectionStatus, redactError, toWindowRecords } from "./project.js";

/**
 * QualificationDetail assembly, shared by the GET and the recheck POST so the
 * two cannot drift into reporting the same connection differently.
 *
 * Provider validation can be a local credential check or an upstream request.
 * Its success alone establishes neither model support nor generation. The
 * legacy generation field remains a deprecated projection of this check.
 */
export function qualificationDetail({ conn, drain, probe, windows, now = Date.now() }) {
  const base = connectionStatus(conn, { isDraining: Boolean(drain?.isDraining), now });
  const checkedAt = typeof probe?.checkedAt === "string" && Number.isFinite(Date.parse(probe.checkedAt))
    ? new Date(probe.checkedAt).toISOString() : null;
  const validation = {
    ok: typeof probe?.ok === "boolean" ? probe.ok : null,
    kind: "provider-validation",
    source: probe ? "recorded-recheck" : "not-recorded",
    checkedAt,
    model: null,
    latencyMs: Number.isFinite(probe?.latencyMs) && probe.latencyMs >= 0 ? probe.latencyMs : null,
    error: redactError(probe?.error),
    upstreamContact: "not-recorded",
    generationVerified: false,
  };
  return {
    connectionId: conn.id,
    provider: conn.provider,
    // "error" is the ABI's one status beyond the Connection enum, and it is
    // narrower than "degraded": the connection's last probe actually failed,
    // as opposed to it being rate-limited or disabled.
    status: base === "degraded" && conn.testStatus === "error" ? "error" : base,
    checkedAt,
    validation,
    generation: {
      ok: validation.ok === true,
      model: null,
      latencyMs: validation.latencyMs,
      error: validation.error,
    },
    quota: toWindowRecords(windows),
  };
}
