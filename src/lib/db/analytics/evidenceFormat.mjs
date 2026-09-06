import { InvestigationError } from './investigationModel.mjs';

export const EXPORT_LIMITS = { records: 5000, bytes: 8 * 1024 * 1024 };

export function serializeEvidence(payload, pretty = false) {
  const serialized = JSON.stringify(payload, null, pretty ? 2 : undefined);
  if (new TextEncoder().encode(serialized).byteLength > EXPORT_LIMITS.bytes) {
    throw new InvestigationError(
      'The complete evidence file exceeds 8 MiB, including metadata and formatting. Narrow the scope; no partial export was produced.',
      413,
      'export_too_large'
    );
  }
  return serialized;
}
