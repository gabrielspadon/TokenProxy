// Additive budget state. No cascade removes exposure when a key is revoked.
export const API_KEY_BUDGET_COLUMNS = { budgetPolicy: "TEXT" };

export const BUDGET_TABLES = {
  apiKeyBudgetAccounts: {
    columns: {
      apiKeyId: "TEXT PRIMARY KEY",
      recordedPromptTokens: "INTEGER NOT NULL DEFAULT 0",
      recordedCompletionTokens: "INTEGER NOT NULL DEFAULT 0",
      recordedCostUsd: "REAL NOT NULL DEFAULT 0",
      unknownPromptRows: "INTEGER NOT NULL DEFAULT 0",
      unknownCompletionRows: "INTEGER NOT NULL DEFAULT 0",
      unknownCostRows: "INTEGER NOT NULL DEFAULT 0",
      initializedAt: "TEXT NOT NULL",
      historyThroughId: "INTEGER NOT NULL DEFAULT 0",
    },
  },
  apiKeyBudgetReservations: {
    columns: {
      requestId: "TEXT PRIMARY KEY",
      logicalRequestId: "TEXT",
      apiKeyId: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      state: "TEXT NOT NULL",
      policy: "TEXT NOT NULL",
      reservedPromptTokens: "INTEGER",
      reservedCompletionTokens: "INTEGER",
      reservedCostUsd: "REAL",
      actualPromptTokens: "INTEGER",
      actualCompletionTokens: "INTEGER",
      actualCostUsd: "REAL",
      rateSnapshotId: "TEXT",
      dispatchCoverage: "TEXT",
      boundEvidence: "TEXT",
      resolutionEvidence: "TEXT",
      usageRowId: "INTEGER",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_budget_key_state ON apiKeyBudgetReservations(apiKeyId,state)",
      "CREATE INDEX IF NOT EXISTS idx_budget_logical ON apiKeyBudgetReservations(logicalRequestId)",
      "CREATE INDEX IF NOT EXISTS idx_budget_state_updated ON apiKeyBudgetReservations(state,updatedAt)",
    ],
  },
};
