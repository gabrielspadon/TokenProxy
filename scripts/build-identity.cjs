const fs = require('node:fs');
const path = require('node:path');

// Read the identity baked into this build, never the checkout's later HEAD.
function copyBuildIdentity(buildDirectory, destination) {
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDirectory, 'required-server-files.json'), 'utf8'));
  const sha = manifest.config?.env?.TP_BUILD_SHA;
  const target = path.join(destination, 'BUILD_SHA');
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
    fs.rmSync(target, { force: true });
    return null;
  }
  fs.writeFileSync(target, `${sha}\n`);
  return sha;
}

module.exports = { copyBuildIdentity };
