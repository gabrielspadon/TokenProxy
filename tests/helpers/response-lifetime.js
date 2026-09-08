import { afterEach } from 'vitest';

// A handler test is the HTTP response consumer. Dispose unread bodies between
// tests so a live request permit cannot leak into an unrelated test case.
export function trackResponseLifetime(handler) {
  const responses = new Set();
  afterEach(async () => {
    try {
      for (const response of responses) {
        if (response?.body && !response.bodyUsed && !response.body.locked) await response.body.cancel();
      }
    } finally { responses.clear(); }
  });
  return async (...args) => {
    const response = await handler(...args);
    responses.add(response);
    return response;
  };
}
