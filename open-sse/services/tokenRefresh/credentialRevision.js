import { createHash } from 'node:crypto';

// Only refresh-relevant fields participate. Names, quota observations and
// unrelated health updates must not discard a valid one-use token rotation.
const FIELDS = ['provider','authType','isActive','accessToken','refreshToken','apiKey','token','idToken','expiresAt','tokenExpiresAt','lastRefreshAt','lastRefresh','projectId','providerSpecificData'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value ?? null;
}
export function credentialContentRevision(credentials) {
  return createHash('sha256').update(JSON.stringify(FIELDS.map(key=>canonical(credentials?.[key])))).digest('hex');
}

export function credentialRevision(credentials) {
  return createHash("sha256").update(`${credentialContentRevision(credentials)}:${credentials?.credentialRevisionId || "legacy"}`).digest("hex");
}

// Cancellation releases this waiter, never the shared one-use redemption.
// Its result can still be recovered by another compatible caller.
export function waitForRefresh(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason ?? new DOMException('Refresh cancelled','AbortError'));
    if (signal.aborted) { pending.catch(()=>{});abort();return; }
    signal.addEventListener('abort',abort,{once:true});
    pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
