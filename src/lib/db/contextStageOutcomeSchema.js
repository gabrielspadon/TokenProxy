// Historical byte-derived outcomes stay distinguishable from observed execution.
export const CONTEXT_STAGE_OUTCOME_COLUMNS = {
  errorCode: "TEXT",
  outcomeSource: "TEXT",
  executionRequestId: "TEXT",
  durationMs: "REAL CHECK (durationMs IS NULL OR durationMs >= 0)",
  durationSource: "TEXT NOT NULL DEFAULT 'unknown' CHECK (durationSource IN ('monotonic','unknown'))",
};
