const SOURCES = new Set(['requestStats', 'usageHistory']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Identifiers come from source code, never request parameters. Projection rows
// retain the source id and trusted dataOrigin so the same predicate applies.
export function telemetryFilterSql(sourceTable, alias = sourceTable) {
  if (!SOURCES.has(sourceTable) || !IDENTIFIER.test(alias)) {
    throw new Error('Invalid telemetry filter source');
  }
  return `(COALESCE(${alias}.dataOrigin,'unknown') <> 'test' AND NOT EXISTS (
    SELECT 1 FROM telemetryQuarantineRows tq
    JOIN telemetryQuarantineReceipts tr ON tr.id=tq.receiptId AND tr.state='active'
    WHERE tq.sourceTable='${sourceTable}' AND tq.rowId=CAST(${alias}.id AS TEXT)
  ))`;
}
