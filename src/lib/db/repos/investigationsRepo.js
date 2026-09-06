import { randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { InvestigationError, OWNER_SCOPE, validateSave, text } from '../analytics/investigationModel.mjs';

function project(row) {
  return row ? { id: row.id, ownerScope: row.ownerScope, name: row.name, kind: row.kind,
    definition: JSON.parse(row.definition), version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
}
export function investigationStore(db, ownerScope = OWNER_SCOPE) {
  const read = (id) => project(db.get('SELECT * FROM investigations WHERE id=? AND ownerScope=?', [text(id,'investigation ID',80,false),ownerScope]));
  return {
    list() { return db.all('SELECT * FROM investigations WHERE ownerScope=? ORDER BY updatedAt DESC,id LIMIT 201',[ownerScope]).map(project); },
    get: read,
    create(input) {
      const value = validateSave(input), id = randomUUID(), now = new Date().toISOString();
      db.transaction(() => {
        if (db.get('SELECT COUNT(*) AS count FROM investigations WHERE ownerScope=?',[ownerScope]).count >= 200) throw new InvestigationError('This operator workspace already has 200 saved entries. Remove an entry before adding another.',409,'capacity_reached');
        db.run('INSERT INTO investigations (id,ownerScope,name,kind,definition,version,createdAt,updatedAt) VALUES (?,?,?,?,?,1,?,?)',
          [id,ownerScope,value.name,value.kind,JSON.stringify(value.definition),now,now]);
      });
      return read(id);
    },
    update(id,input) {
      const value = validateSave(input,true);
      db.transaction(() => {
        const previous = read(id);
        if (!previous) throw new InvestigationError('Saved entry not found.',404,'not_found');
        if (previous.version !== value.version) throw new InvestigationError('This entry changed in another view. Reload its latest version or save a separate copy.',409,'version_conflict');
        db.run('UPDATE investigations SET name=?,kind=?,definition=?,version=version+1,updatedAt=? WHERE id=? AND ownerScope=? AND version=?',
          [value.name,value.kind,JSON.stringify(value.definition),new Date().toISOString(),id,ownerScope,value.version]);
      });
      return read(id);
    },
    remove(id,version) {
      if (!Number.isSafeInteger(version) || version < 1) throw new InvestigationError('Expected version is required.');
      db.transaction(() => {
        const previous = read(id);
        if (!previous) throw new InvestigationError('Saved entry not found.',404,'not_found');
        if (previous.version !== version) throw new InvestigationError('The entry changed. Reload before deleting.',409,'version_conflict');
        db.run('DELETE FROM investigations WHERE id=? AND ownerScope=? AND version=?',[id,ownerScope,version]);
      });
      return { deleted: true, id };
    },
  };
}
export async function getInvestigationStore() { return investigationStore(await getAdapter()); }
