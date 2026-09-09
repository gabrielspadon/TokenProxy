import { capabilityEvidence, qualifiedRegressionEvidence } from '../../compatibility/evidence.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { CompatibilityError, LIMITS, OWNER_SCOPE, IMPLEMENTATION_VERSION, TERMINAL, identifier, revision, validateFixture, boundedJson } from '../../compatibility/model.mjs';

const projectFixture = row => row ? { ...row, archived: Boolean(row.archived), definition: JSON.parse(row.definition) } : null;
const projectRun = row => row ? { ...row, processOwner: undefined, result: row.result ? JSON.parse(row.result) : null, error: row.error ? JSON.parse(row.error) : null } : null;
export function compatibilityStore(db, ownerScope = OWNER_SCOPE) {
  const getFixture = (id, rev) => projectFixture(db.get(`SELECT * FROM compatibilityFixtures WHERE id=? AND ownerScope=?${rev ? ' AND revision=?' : ''} ORDER BY revision DESC LIMIT 1`, [identifier(id), ownerScope, ...(rev ? [revision(rev)] : [])]));
  const getRun = id => projectRun(db.get('SELECT * FROM compatibilityRuns WHERE id=? AND ownerScope=?', [identifier(id), ownerScope]));
  const count = table => db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ownerScope=?`, [ownerScope]).n;
  function writeFixture(id, value, rev) {
    if (count('compatibilityFixtures') >= LIMITS.revisions) throw new CompatibilityError('Retained fixture revision capacity reached. Existing evidence is preserved.', 409, 'capacity_reached');
    const json = boundedJson(value.definition, LIMITS.definitionBytes);
    db.run('INSERT INTO compatibilityFixtures (id,revision,ownerScope,name,definition,contentHash,archived,createdAt) VALUES (?,?,?,?,?,?,?,?)', [id, rev, ownerScope, value.name, json, createHash('sha256').update(json).digest('hex'), value.archived ? 1 : 0, new Date().toISOString()]);
    return getFixture(id, rev);
  }
  return {
    getFixture, getRun,
    listFixtures() {
      return db.all('SELECT f.* FROM compatibilityFixtures f WHERE f.ownerScope=? AND f.revision=(SELECT MAX(g.revision) FROM compatibilityFixtures g WHERE g.id=f.id AND g.ownerScope=f.ownerScope) ORDER BY f.createdAt DESC,f.id', [ownerScope]).map(projectFixture);
    },
    createFixture(input) {
      const value = validateFixture(input);
      return db.transaction(() => {
        if (db.get('SELECT COUNT(DISTINCT id) AS n FROM compatibilityFixtures WHERE ownerScope=?', [ownerScope]).n >= LIMITS.fixtureIds) throw new CompatibilityError('Fixture capacity reached. Existing fixtures are preserved.', 409, 'capacity_reached');
        return writeFixture(randomUUID(), value, 1);
      });
    },
    updateFixture(id, input) {
      const value = validateFixture(input, true);
      return db.transaction(() => {
        const previous = getFixture(id);
        if (!previous) throw new CompatibilityError('Fixture not found.', 404, 'not_found');
        if (previous.revision !== value.revision) throw new CompatibilityError('This fixture changed in another view. Reload it or save a separate copy; your edits remain.', 409, 'revision_conflict');
        return writeFixture(id, value, previous.revision + 1);
      });
    },
    createRun(id, rev, processOwner) {
      return db.transaction(() => {
        const fixture = getFixture(id, rev), latest = getFixture(id);
        if (!fixture) throw new CompatibilityError('Exact fixture revision not found.', 404, 'not_found');
        if (fixture.archived || latest?.archived) throw new CompatibilityError('Archived fixtures cannot start a new run.', 409, 'archived');
        if (count('compatibilityRuns') >= LIMITS.runs) throw new CompatibilityError('Retained run capacity reached. No prior evidence was deleted.', 409, 'capacity_reached');
        const runId = randomUUID();
        db.run('INSERT INTO compatibilityRuns (id,ownerScope,fixtureId,fixtureRevision,fixtureHash,scope,status,implementationVersion,processOwner,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)', [runId, ownerScope, id, rev, fixture.contentHash, fixture.definition.scope || 'local-translation', 'queued', IMPLEMENTATION_VERSION, processOwner, new Date().toISOString()]);
        return { run: getRun(runId), fixture };
      });
    },
    transition(id, status, { result = null, error = null } = {}) {
      return db.transaction(() => {
        const previous = getRun(id);
        if (!previous) throw new CompatibilityError('Run not found.', 404, 'not_found');
        if (TERMINAL.includes(previous.status)) return previous;
        if (!['running', ...TERMINAL].includes(status)) throw new CompatibilityError('Invalid run transition.');
        if (status === 'running' && previous.status !== 'queued') return previous;
        const now = new Date().toISOString();
        db.run('UPDATE compatibilityRuns SET status=?,result=?,error=?,startedAt=COALESCE(startedAt,?),finishedAt=? WHERE id=? AND ownerScope=? AND status IN (?,?)', [status, result ? boundedJson(result, LIMITS.resultBytes) : null, error ? boundedJson(error, 2048) : null, status === 'running' ? now : null, TERMINAL.includes(status) ? now : null, id, ownerScope, 'queued', 'running']);
        return getRun(id);
      });
    },
    interruptPrevious(processOwner) {
      db.run("UPDATE compatibilityRuns SET status='interrupted',finishedAt=?,error=? WHERE ownerScope=? AND processOwner<>? AND status IN ('queued','running')", [new Date().toISOString(), JSON.stringify({ code: 'process_interrupted', message: 'The prior process ended. This run was not replayed.' }), ownerScope, processOwner]);
    },
    listRuns({ page = 1, pageSize = 25, fixtureId } = {}) {
      const where = `ownerScope=?${fixtureId ? ' AND fixtureId=?' : ''}`, args = [ownerScope, ...(fixtureId ? [identifier(fixtureId)] : [])];
      const total = db.get(`SELECT COUNT(*) AS n FROM compatibilityRuns WHERE ${where}`, args).n;
      const items = db.all(`SELECT * FROM compatibilityRuns WHERE ${where} ORDER BY createdAt DESC,id LIMIT ? OFFSET ?`, [...args, pageSize, (page - 1) * pageSize]).map(projectRun);
      const counts = db.get("SELECT SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running FROM compatibilityRuns WHERE ownerScope=?", [ownerScope]);
      return { items, queue: { queued: counts.queued || 0, running: counts.running || 0, scope: 'installation-operator' }, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
    },
    evidenceRuns() {
      return db.all(`SELECT r.*,json_extract(f.definition,'$.sourceFormat') AS sourceFormat,
        json_extract(f.definition,'$.targetFormat') AS targetFormat,json_extract(f.definition,'$.operation') AS operation,
        json_extract(f.definition,'$.model') AS model FROM compatibilityRuns r JOIN compatibilityFixtures f
        ON f.id=r.fixtureId AND f.revision=r.fixtureRevision AND f.ownerScope=r.ownerScope WHERE r.ownerScope=?`, [ownerScope]).map(projectRun);
    },
    evidence() { return capabilityEvidence(this.evidenceRuns()); },
    regressions() { return qualifiedRegressionEvidence(this.evidenceRuns()); },
  };
}
export async function getCompatibilityStore() { return compatibilityStore(await getAdapter()); }
