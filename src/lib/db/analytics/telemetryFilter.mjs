const SOURCES = new Set(['requestStats', 'usageHistory']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Identifiers come from source code, never request parameters. Projection rows
// retain the source id and trusted dataOrigin so the same predicate applies.
export function telemetryFilterSql(sourceTable, alias = sourceTable) {
  if (!SOURCES.has(sourceTable) || !IDENTIFIER.test(alias)) {
    throw new Error('Invalid telemetry filter source');
  }
  // The active-quarantine membership set does not depend on the row being
  // tested, so it is built once per query instead of once per population row.
  // Correlating it cost one index probe per row, and the economics population
  // scans the whole projection three times (summary, groups, series).
  // rowId keeps its exact legacy textual identity and stays table-qualified;
  // the IS NOT NULL guard keeps a NULL out of the NOT IN set, and the id IS
  // NULL arm preserves the old NOT EXISTS result for a row with no id.
  const visible = `(COALESCE(${alias}.dataOrigin,'unknown') <> 'test' AND (${alias}.id IS NULL OR CAST(${alias}.id AS TEXT) NOT IN (
    SELECT tq.rowId FROM telemetryQuarantineRows tq
    JOIN telemetryQuarantineReceipts tr ON tr.id=tq.receiptId AND tr.state='active'
    WHERE tq.sourceTable='${sourceTable}' AND tq.rowId IS NOT NULL
  )))`;
  if (sourceTable === 'usageHistory') return visible;
  // Only the backfill writer sets this provenance link. A historical id that
  // happens to look like "bh-1" proves nothing about its source.
  return `(${visible} AND NOT EXISTS (
    SELECT 1 FROM usageHistory telemetry_source_usage
    WHERE telemetry_source_usage.id=${alias}.sourceUsageId
      AND NOT ${telemetryFilterSql('usageHistory', 'telemetry_source_usage')}
  ))`;
}
