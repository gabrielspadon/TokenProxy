import { afterAll, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';

let db;
afterAll(() => db?.close());

it('ties retained compatibility runs to an existing immutable fixture revision', async () => {
  db = await getAdapter();
  const now = '2026-09-06T19:00:00.000Z';
  const insertRun = (id, fixtureRevision) => db.run(`INSERT INTO compatibilityRuns
    (id,ownerScope,fixtureId,fixtureRevision,fixtureHash,scope,status,implementationVersion,processOwner,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id,'operator','fixture',fixtureRevision,'hash','local-translation','queued','fixture-build','process',now]);
  expect(() => insertRun('missing', 1)).toThrow(/FOREIGN KEY/i);
  db.run(`INSERT INTO compatibilityFixtures(id,revision,ownerScope,name,definition,contentHash,createdAt)
    VALUES (?,?,?,?,?,?,?)`, ['fixture',1,'operator','Fixture','{}','hash',now]);
  expect(() => insertRun('missing-revision', 2)).toThrow(/FOREIGN KEY/i);
  insertRun('valid',1);
  expect(db.get('SELECT fixtureRevision FROM compatibilityRuns WHERE id = ?', ['valid']).fixtureRevision).toBe(1);
  expect(() => db.run('DELETE FROM compatibilityFixtures WHERE id = ? AND revision = ?', ['fixture',1])).toThrow(/FOREIGN KEY/i);
  expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
});
