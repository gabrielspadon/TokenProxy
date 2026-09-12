const SOURCES = new Set(['requestStats', 'usageHistory']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Identifiers come from source code, never request parameters. Projection rows
// retain the source id and trusted dataOrigin so the same predicate applies.
export function telemetryFilterSql(sourceTable, alias = sourceTable) {
  if (!SOURCES.has(sourceTable) || !IDENTIFIER.test(alias)) {
    throw new Error('Invalid telemetry filter source');
  }
  const visible = `(COALESCE(${alias}.dataOrigin,'unknown') <> 'test' AND NOT EXISTS (
    SELECT 1 FROM telemetryQuarantineRows tq
    JOIN telemetryQuarantineReceipts tr ON tr.id=tq.receiptId AND tr.state='active'
    WHERE tq.sourceTable='${sourceTable}' AND tq.rowId=CAST(${alias}.id AS TEXT)
  ))`;
  if (sourceTable === 'usageHistory') return visible;
  // Only the backfill writer sets this provenance link. A historical id that
  // happens to look like "bh-1" proves nothing about its source.
  return `(${visible} AND NOT EXISTS (
    SELECT 1 FROM usageHistory telemetry_source_usage
    WHERE telemetry_source_usage.id=${alias}.sourceUsageId
      AND NOT ${telemetryFilterSql('usageHistory', 'telemetry_source_usage')}
  ))`;
}
