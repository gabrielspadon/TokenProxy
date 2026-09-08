export const PROJECT_NOTIFICATION_COLUMNS = {
  notificationTargets: 'TEXT',
  notificationQueuedAt: 'TEXT',
  notificationRetryAt: 'TEXT',
  notificationErrorCode: 'TEXT',
  notificationAttempts: 'INTEGER NOT NULL DEFAULT 0',
};

export const NOTIFICATION_DELIVERY_TABLES = {
  notificationDeliveries: {
    columns: {
      id: 'TEXT PRIMARY KEY', eventId: 'TEXT NOT NULL', event: 'TEXT NOT NULL',
      endpointId: 'TEXT NOT NULL', destinationHash: 'TEXT NOT NULL', payload: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL', state: 'TEXT NOT NULL',
      owner: 'TEXT', leaseUntil: 'TEXT', attempts: 'INTEGER NOT NULL DEFAULT 0',
      status: 'INTEGER', error: 'TEXT',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_nd_state_created ON notificationDeliveries(state,createdAt,id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_nd_event_target ON notificationDeliveries(event,eventId,endpointId)',
    ],
  },
};
