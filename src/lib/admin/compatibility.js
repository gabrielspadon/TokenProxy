import { requireAdmin } from './guard.js';
import { adminError, adminJson } from './policy.js';
import { CompatibilityError } from '../compatibility/model.mjs';

export async function compatibilityResponse(request, action) {
  const denied = await requireAdmin(request); if (denied) return denied;
  try { return adminJson(await action()); }
  catch (error) { return error instanceof CompatibilityError ? adminError(error.status, error.code, error.message) : adminError(503, 'state_unavailable', 'Compatibility evidence could not be read or retained. No action was replayed.'); }
}
export async function compatibilityBody(request) {
  const reader = request.body?.getReader(); if (!reader) throw new CompatibilityError('A JSON body is required.');
  const chunks = []; let bytes = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 70000) { await reader.cancel(); throw new CompatibilityError('The request exceeds the70,000byte input boundary.', 413, 'too_large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new CompatibilityError('Invalid JSON.'); }
}
