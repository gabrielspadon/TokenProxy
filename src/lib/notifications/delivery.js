import { getAdapter } from '@/lib/db/driver.js';
import { claimDeliveries, destinationHash, finishDelivery } from './outbox.mjs';
import { deliver, getNotificationsConfig } from './webhooks.js';
import { recoverProjectNotifications } from './projectRecovery.mjs';

export async function drainNotifications({ signal, db: providedDb, config: suppliedConfig,
  send = deliver, now = Date.now() } = {}) {
  signal?.throwIfAborted();
  const db = providedDb ?? await getAdapter();
  const config = suppliedConfig ?? await getNotificationsConfig();
  recoverProjectNotifications(db, { now });
  const claims = claimDeliveries(db, { now });
  await Promise.all(claims.map(async claim => {
    let result;
    try {
      const target = config.endpoints.find(e => e.id === claim.endpointId);
      if (!config.enabled || !target?.active || !target.events.includes(claim.event) ||
          destinationHash(target.url) !== claim.destinationHash) {
        result = { cancelled: true, error: 'Destination disabled, changed or unsubscribed' };
      } else {
        signal?.throwIfAborted();
        result = await send(target, claim.event, JSON.parse(claim.payload), {
          signal, deliveryId: claim.id,
        });
      }
    } catch {
      result = { uncertain: true, error: 'Delivery interrupted before confirmation' };
    }
    finishDelivery(db, claim, result);
  }));
  return { processed: claims.length };
}
