import { prepareShapingFixture } from '../../scripts/qa/browser-workflow-fixtures.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(process.argv[2] || '/tmp/shaping-experiments-evidence');
mkdirSync(artifacts, { recursive: true });
const launch = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [join(project, 'scripts/redesign-preview.mjs'), ...args], {
      cwd: project,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  );
const seeded = launch('seed', '--mode', 'dev', '--scenario', 'representative');
prepareShapingFixture(seeded, artifacts);
let started = false;
try {
  launch('start', '--mode', 'dev', '--run', seeded.root);
  started = true;
  execFileSync(
    process.execPath,
    [join(project, 'tests/e2e/shaping-completion-acceptance.mjs'), seeded.root, artifacts],
    { cwd: project, stdio: 'inherit', timeout: 420000 }
  );
} finally {
  if (started)
    writeFileSync(
      join(artifacts, 'stopped.json'),
      JSON.stringify(launch('stop', '--run', seeded.root), null, 2)
    );
}
