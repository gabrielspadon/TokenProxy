import { randomUUID } from 'node:crypto';
import { requireAdmin } from '@/lib/admin/guard.js';
import { adminError, adminJson } from '@/lib/admin/policy.js';
import { getApiKeyById } from '@/lib/db/repos/apiKeysRepo.js';
import { recordOperationTerminal } from '@/lib/db/repos/operationEventsRepo.js';

export const dynamic = 'force-dynamic';

// The explicit POST is deliberate disclosure of this one credential. List,
// detail, device and update responses never include the stored value.
//
// FAIL CLOSED ON THE AUDIT. The event row is written BEFORE the response is
// built, and a retention failure refuses the disclosure rather than handing out
// a credential that left no trace: an operator retrying a 500 is recoverable,
// an untraceable disclosure is not. The row records THAT the secret was read,
// never the secret — sanitizeOperationDetails would drop it anyway, and nothing
// here offers it.
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (typeof id !== 'string' || id.length > 128)
      return adminError(400, 'invalid_key_id', 'Invalid key identifier.');
    const stored = await getApiKeyById(id);
    const eventBase = {
      operationId: randomUUID(),
      phase: 'authentication',
      source: 'api-key-reveal',
      actorClass: 'operator',
      subjectKind: 'apiKey',
      subjectId: id,
    };
    const details = { kind: 'credential-disclosure', reason: 'explicit-operator-request' };
    if (!stored) {
      await recordOperationTerminal(eventBase, { state: 'failed', code: 'key_not_found', details });
      return adminError(404, 'key_not_found', 'Key not found.');
    }
    await recordOperationTerminal(eventBase, {
      state: 'succeeded',
      code: 'credential_disclosed',
      details,
    });
    return adminJson({
      id: stored.id,
      name: stored.name,
      key: stored.key,
      isActive: stored.isActive,
      isExpired: stored.isExpired,
      expiresAt: stored.expiresAt,
      disclosure: 'explicit-operator-request',
    });
  } catch {
    return adminError(500, 'key_unavailable', 'The key could not be revealed.');
  }
}
