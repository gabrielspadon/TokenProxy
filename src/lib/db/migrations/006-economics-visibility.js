import { setMetaSync } from '../helpers/metaStore.js';
import { ECONOMICS_PROJECTION_META_KEY } from '../economicsProjectionSchema.js';

const migration = {
  version: 6,
  name: 'economics-visibility',
  up(db) {
    // Schema synchronization and the full rebuild share the migration runner's
    // transaction. Source ledgers are preserved even if rebuilding fails.
    setMetaSync(db, ECONOMICS_PROJECTION_META_KEY, 0);
  },
};

export default migration;
