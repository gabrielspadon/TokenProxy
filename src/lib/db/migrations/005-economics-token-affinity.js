import { setMetaSync } from '../helpers/metaStore.js';
import { ECONOMICS_PROJECTION_META_KEY } from '../economicsProjectionSchema.js';

const migration = {
  version: 5,
  name: 'economics-token-affinity',
  up(db) {
    setMetaSync(db, ECONOMICS_PROJECTION_META_KEY, 0);
  },
};

export default migration;
