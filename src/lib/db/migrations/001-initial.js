// Create missing tables. The shared additive sync adds missing columns before
// indexes, including when an unversioned predecessor already has these tables.
import { TABLES, buildCreateTableSql } from '../schema.js';

const migration = {
  version: 1,
  name: 'initial',
  up(db) {
    for (const [name, def] of Object.entries(TABLES)) {
      db.exec(buildCreateTableSql(name, def));
    }
  },
};

export default migration;
