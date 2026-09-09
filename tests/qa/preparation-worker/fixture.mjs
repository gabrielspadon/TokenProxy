import { createHash } from 'node:crypto';

// Controlled CPU surrogate, no provider or optional package is imported.
// Both measurement arms execute these exact operations and verify the digest.
export async function transformAnthropicMessages({ body }) {
  let digest;
  for (let index = 0; index < 32; index++) digest = createHash('sha256').update(body).digest('hex');
  return { applied: false, reason: 'controlled-fixture', body, digest };
}
