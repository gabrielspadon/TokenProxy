// Error normalization must preserve a transport's replay denial and requested
// cooldown without forwarding cookies or other private upstream headers.
export function rejectionHeaders(response) {
  const headers = { 'Content-Type': 'application/json' };
  for (const name of ['x-tokenproxy-replay-safe', 'x-should-retry', 'retry-after']) {
    const value = response?.headers?.get?.(name);
    if (value !== null && value !== undefined) headers[name] = value;
  }
  return headers;
}
