// TokenProxy's first schema. A fresh install creates every table and index
// declared in TABLES; there is no earlier version to upgrade from.
import { TABLES, buildCreateTableSql } from '../schema.js';

const migration = {
  version: 1,
  name: 'initial',
  up(db) {
    for (const [name, def] of Object.entries(TABLES)) {
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};

export default migration;
