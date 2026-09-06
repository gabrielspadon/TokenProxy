// Operator-authored notification rules and the alerts they produced.
//
// Two tables, one purpose each. `notificationRules` is mutable current
// configuration carrying an optimistic-concurrency `revision`.
// `notificationRuleEvents` is the append-then-annotate alert log: a row is
// written when a rule fires and is afterwards only annotated with operator
// disposition (acknowledged, snoozed). The evidence that caused a firing is
// stored as identifier references, never as a copied measurement, so an alert
// always resolves to the retained records that justify it rather than to a
// snapshot that can silently disagree with them.
//
// NOTIFICATIONS ONLY. Neither table has a column describing an action to take,
// because this subsystem never takes one. See docs/design/NOTIFICATION-RULES.md.
export const NOTIFICATION_RULE_TABLES = {
  notificationRules: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      // 'global' watches every scope key the condition produces and fires per
      // key. 'connection' and 'provider' restrict it to one subject.
      scopeKind: "TEXT NOT NULL CHECK (scopeKind IN ('global','connection','provider'))",
      // NULL exactly when scopeKind = 'global'; enforced by the CHECK below.
      scopeId: 'TEXT',
      conditionKind: 'TEXT NOT NULL',
      threshold: 'REAL NOT NULL',
      // Sustain requirement or counting window, per the condition's declared
      // durationRole. Never zero: an instantaneous rule is a rule with no
      // evidence of persistence behind it.
      durationSeconds: 'INTEGER NOT NULL CHECK (durationSeconds > 0)',
      // Minimum spacing between two firings of one rule on one scope key.
      // Floored well above zero so a sustained breach cannot emit per sample.
      cooldownSeconds: 'INTEGER NOT NULL CHECK (cooldownSeconds >= 60)',
      enabled: 'INTEGER NOT NULL DEFAULT 1',
      // Optimistic concurrency. Every accepted write increments it; a write
      // carrying a stale value is refused rather than applied.
      revision: 'INTEGER NOT NULL DEFAULT 1',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    constraints: ["CHECK ((scopeKind = 'global') = (scopeId IS NULL))", 'CHECK (revision > 0)'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_nr_enabled ON notificationRules(enabled, conditionKind)',
      'CREATE INDEX IF NOT EXISTS idx_nr_condition ON notificationRules(conditionKind, scopeKind, scopeId)',
    ],
  },
  // Every change to a rule, kept so a firing recorded against revision N stays
  // interpretable after the rule has moved on to revision N+3.
  notificationRuleVersions: {
    columns: {
      ruleId: 'TEXT NOT NULL',
      revision: 'INTEGER NOT NULL',
      // 'created' | 'updated' | 'enabled' | 'disabled' | 'deleted'.
      change: 'TEXT NOT NULL',
      // The full rule definition as of this revision, as JSON.
      definition: 'TEXT NOT NULL',
      changedAt: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (ruleId, revision)',
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_nrv_changed ON notificationRuleVersions(changedAt, ruleId)',
    ],
  },
  notificationRuleEvents: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      ruleId: 'TEXT NOT NULL',
      // The revision that was live when this fired. A later edit does not
      // rewrite history, so an alert keeps the definition that produced it.
      ruleRevision: 'INTEGER NOT NULL',
      // The subject the rule fired on: one connection, one quota window, one
      // provider. A 'global' rule produces one key per subject it matched.
      scopeKey: 'TEXT NOT NULL',
      firedAt: 'TEXT NOT NULL',
      // When the breach that justified this firing began, which is firedAt
      // minus at least durationSeconds.
      breachStartedAt: 'TEXT NOT NULL',
      // The measured value at the firing instant, in the condition's own unit.
      observedValue: 'REAL',
      // JSON: { kind, refs: [...] } — identifiers of the retained records that
      // caused this. Never a copy of their contents.
      evidence: 'TEXT NOT NULL',
      acknowledgedAt: 'TEXT',
      snoozedUntil: 'TEXT',
      // 'firing' while it still occupies the rule+scope slot, 'acknowledged'
      // once an operator has taken it. A snoozed alert stays 'firing': snooze
      // suppresses repetition, it does not resolve the alert.
      outcome: "TEXT NOT NULL DEFAULT 'firing' CHECK (outcome IN ('firing','acknowledged'))",
    },
    constraints: [
      // An acknowledged row carries its timestamp and a firing row does not.
      "CHECK ((outcome = 'acknowledged') = (acknowledgedAt IS NOT NULL))",
    ],
    indexes: [
      // THE duplicate-firing constraint: one open alert per rule per scope.
      // A second firing cannot be written while the first is unacknowledged,
      // so a sustained breach yields one actionable alert rather than a queue.
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_nre_open ON notificationRuleEvents(ruleId, scopeKey) WHERE outcome = 'firing'",
      'CREATE INDEX IF NOT EXISTS idx_nre_rule_fired ON notificationRuleEvents(ruleId, firedAt, id)',
      'CREATE INDEX IF NOT EXISTS idx_nre_fired ON notificationRuleEvents(firedAt, id)',
      'CREATE INDEX IF NOT EXISTS idx_nre_outcome ON notificationRuleEvents(outcome, firedAt)',
    ],
  },
};
