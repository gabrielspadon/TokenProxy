import { createContextTelemetry, recordContextAttempt } from "open-sse/handlers/chatCore/contextTelemetry.js";

// Media cores call beforeDispatch only after validation and request construction.
// It also separates an authentication retry from the rejected physical attempt.
export function createUsageAttemptTracker(identity, fields, credentials) {
  let current = null;
  const finish = async (result) => {
    if (!current) return;
    await recordContextAttempt(current, { ...fields, status: result.success ? "success" : "error", tokens: result.usage ?? null });
  };
  return {
    get contextTelemetry() { return current; },
    async beforeDispatch() {
      if (current) await finish({ success: false });
      current = createContextTelemetry({ ...identity, timestamp: new Date().toISOString(),
        dispatchCoverage: "physical-dispatch",
        sessionHash: credentials?.sessionHash, sessionIdentitySource: credentials?.sessionIdentitySource, stages: [] });
      await recordContextAttempt(current, fields);
    },
    finish,
  };
}
