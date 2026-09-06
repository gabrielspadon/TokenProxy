/** Provider status alone cannot distinguish exhausted entitlement from a burst. */
export function classifyAccountFailure(status, error, metadata = null) {
  if (metadata?.unknownModelVerified === true) return 'capability';
  const code = Number(status);
  if (code === 401 || code === 403 || code === 404) return 'credential';
  if (code === 402) return 'quota';
  if (code !== 429) return 'transient';
  const message = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  if (/usage_limit_reached|insufficient_quota|quota_exhausted|quota_limit_exceeded|(?:extra usage|usage credits) (?:is|are) required for long context|(?:weekly|monthly|daily|session) (?:usage |quota )?limit (?:reached|exceeded)|(?:quota|credits?) (?:has been |is |are )?(?:exhausted|depleted)/i.test(message)) {
    return 'quota';
  }
  return 'rate';
}
