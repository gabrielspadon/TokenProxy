import { getAdapter } from '../driver.js';
import { DATA_FILE } from '../paths.js';
import { readContextAnalytics } from '../analytics/client.js';
import {
  parseSessionPinTimelineQuery,
  PIN_TIMELINE_REQUEST_PARAMS,
} from '../analytics/sessionPinTimelineQueries.mjs';
import { decodePinId, PinControlError } from './sessionPinsRepo.js';

// The wire names the pin by its opaque id; the routing hash and physical model
// come out of decoding it, never off the request. That keeps the drilldown on
// the exact same (identity, model) scope the pin list and controls act on.
export function pinTimelineParams(params) {
  const seen = new Set();
  for (const [key] of params) {
    if (!PIN_TIMELINE_REQUEST_PARAMS.includes(key) || seen.has(key))
      throw new PinControlError('invalid_query');
    seen.add(key);
  }
  const pinId = params.get('pinId');
  if (typeof pinId !== 'string' || !pinId) throw new PinControlError('invalid_pin_id');
  const key = decodePinId(pinId);
  const resolved = new URLSearchParams(params);
  resolved.delete('pinId');
  resolved.set('sessionHash', key.sessionHash);
  resolved.set('model', key.model);
  return resolved;
}

export async function getSessionPinTimeline(params, { signal, now } = {}) {
  let query;
  try {
    query = parseSessionPinTimelineQuery(pinTimelineParams(params), { now });
  } catch (error) {
    if (error instanceof PinControlError) throw error;
    throw new PinControlError('invalid_query');
  }
  const writer = await getAdapter();
  return readContextAnalytics(
    { operation: 'session-pin-timeline', ...query },
    { file: DATA_FILE, driver: writer.driver, signal }
  );
}
