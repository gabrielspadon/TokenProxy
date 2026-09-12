import { setMetaSync } from '../helpers/metaStore.js';
import { ECONOMICS_PROJECTION_META_KEY } from '../economicsProjectionSchema.js';

const migration = {
  version: 7,
  name: 'economics-cache-presence',
  up(db) {
    setMetaSync(db, ECONOMICS_PROJECTION_META_KEY, 0);
  },
};

export default migration;
