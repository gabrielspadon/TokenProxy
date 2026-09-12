export function canStartFrontOutcomeJournal(phase = process.env.NEXT_PHASE) {
  return phase !== "phase-production-build" && phase !== "phase-export" && phase !== "phase-static";
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.TOKENPROXY_TELEMETRY === "otlp") {
      const { initializeTechnicalTelemetry } = await import("@/lib/observability/technicalTelemetry.js");
      await initializeTechnicalTelemetry();
    }
    // Rename process to distinguish tokenproxy from generic next-server
    if (process.title.startsWith("next-server")) {
      process.title = process.title.replace("next-server", "tokenproxy");
    }

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    try {
      const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
      await installCatalogSource();
      const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
      startModelCatalogSync();
    } catch (e) {
      console.warn("[modelCatalog] boot start failed:", e?.message);
    }

    // The application bootstrap belongs here, not in the root layout. Importing
    // it from layout.js meant RENDERING A PAGE was what first ran
    // initializeApp() and its deferred heavy startup: connection cleanup, the
    // network monitor, MITM autostart, quota
    // auto-ping, background token refresh and the free-model sync. That is why
    // opening the dashboard could take the /v1 gateway down with it (#3061),
    // and why MITM autostart never ran on a headless gateway (#1312). It is
    // idempotent through a global guard, so the layout import that remains as a
    // fallback for a bare `next start` is a no-op once this has run.
    try {
      await import("@/shared/services/bootstrap");
    } catch (e) {
      console.error("[Bootstrap] boot start failed:", e?.message);
    }

    try {
      const { startPublicModelCatalogScheduler } = await import("@/app/api/v1/models/route.js");
      startPublicModelCatalogScheduler();
    } catch {
      console.warn("[model-list] background refresh start failed class=initialization");
    }

    // The front persists admission-only outcomes outside the backend process.
    // Import from the shared private data root before request traffic and then
    // keep its incremental reader alive for terminal records.
    if (canStartFrontOutcomeJournal()) {
      try {
        const { startFrontOutcomeJournalIngestion } = await import("@/lib/db/repos/frontOutcomeJournalRepo.js");
        startFrontOutcomeJournalIngestion();
      } catch {
        console.warn("[frontOutcomeJournal] boot start failed class=initialization");
      }
    }

    // Webhook delivery watches signals the router already emits; it has to be
    // subscribed before the first request produces one.
    try {
      const { ensureWatcher } = await import("@/lib/notifications/watcher.js");
      ensureWatcher();
    } catch (e) {
      console.error("[Notifications] watcher start failed:", e?.message);
    }

    // Boot-time schedulers. Started here for the same reason as the bootstrap
    // above: any entrypoint (standalone server.js, custom-server.js, dev).
    const { startFreeModelSync } =
      await import("@/shared/services/freeModelSync");
    startFreeModelSync().catch((e) =>
      console.error("[FreeModelSync] boot start failed:", e.message),
    );

    // Load user contextWindow overrides into the capabilities resolver so
    // /v1/models + request routing honor dashboard edits from boot.
    try {
      const [{ getSettings }, { setContextWindowOverrides }] =
        await Promise.all([
          import("@/lib/db/repos/settingsRepo.js"),
          import("open-sse/providers/capabilities.js"),
        ]);
      const settings = await getSettings();
      setContextWindowOverrides(settings.contextWindowOverrides || {});
    } catch (e) {
      console.warn("[context-overrides] boot load failed:", e?.message);
    }

    // Same for per-model capability overrides declared on custom models, so a
    // hand-added vision model is not treated as text-only from boot (#1904).
    try {
      const { refreshModelCapabilityOverrides } =
        await import("@/lib/modelCapabilityOverrides");
      await refreshModelCapabilityOverrides();
    } catch (e) {
      console.warn("[model-cap-overrides] boot load failed:", e?.message);
    }
  }
}
