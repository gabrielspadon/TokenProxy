#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SHA = /^[a-f0-9]{40}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  requireThat(result.status === 0, `git ${args[0]} failed`);
  return result.stdout;
}
export function candidateFileHash(root, candidateSha, path) {
  requireThat(SHA.test(candidateSha), "candidate source hash requires a full revision");
  return hash(git(root, ["show", `${candidateSha}:${path}`]));
}

export function riskCategory(path) {
  if (/\.(?:test|spec)\.[cm]?js$/u.test(path)) return null;
  if (/^services\/tokenproxy\//u.test(path)) return "admission-front";
  if (/^scripts\/deploy\//u.test(path)) return "deployment";
  if (/^(scripts\/qa\/|scripts\/(redesign-preview|dev-test-server)|tests\/__baseline__\/.*\.[cm]?js$|tests\/qa\/|tests\/contracts\/|tests\/setup-|tests\/vitest|stryker)/u.test(path)) return "gate";
  if (/^(src\/lib\/db\/|src\/lib\/(auth|oidc|saml|encryption|secret|antigravityVerification|network\/)|src\/app\/api\/(auth|settings)\/)/u.test(path)) return "auth-storage-migration";
  if (/^(src\/sse\/|open-sse\/(handlers\/|services\/|utils\/|executors\/|translator\/|config\/(connectTimeout|runtimeConfig)))/u.test(path)) return "admission-retry-credentials";
  if (/^(custom-server\.js|next\.config\.mjs|src\/instrumentation\.js|src\/app\/api\/(ready|health|version|v1)\/|cli\/(hooks|src)\/)/u.test(path)) return "admission-startup";
  return null;
}

function changedRanges(root, baseSha, candidateSha, path) {
  const diff = git(root, ["diff", "--unified=0", "--no-ext-diff", baseSha, candidateSha, "--", path]);
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)].map((match) => {
    const start = Math.max(1, Number(match[1]));
    return { start, end: start + Math.max(1, Number(match[2] ?? 1)) - 1 };
  });
}

export function createRiskScope(root, baseSha, candidateSha) {
  requireThat(SHA.test(baseSha) && SHA.test(candidateSha), "risk scope requires full base and candidate SHAs");
  requireThat(baseSha !== candidateSha, "risk baseline must precede candidate");
  git(root, ["merge-base", "--is-ancestor", baseSha, candidateSha]);
  const changed = git(root, ["diff", "--name-only", "--diff-filter=ACMRT", "-z", baseSha, candidateSha]).split("\0").filter(Boolean).sort();
  const files = changed.filter((path) => riskCategory(path) && /\.[cm]?js$/u.test(path)).map((path) => {
    const changedLines = changedRanges(root, baseSha, candidateSha, path);
    requireThat(changedLines.length > 0, `risk file has no textual changed range: ${path}`);
    return { path, category: riskCategory(path), sha256: hash(git(root, ["show", `${candidateSha}:${path}`])), changedLines };
  });
  requireThat(files.length > 0, "changed risk scope is empty");
  return {
    schema: "tokenproxy-risk-scope-v1", baseSha, candidateSha,
    branchesThreshold: 90, mutationThreshold: 60, selection: "git-changed-branch-locations",
    files,
    separateLanguageGates: changed.filter((path) => riskCategory(path) && !/\.[cm]?js$/u.test(path)),
    pythonFiles: changed.filter((path) => riskCategory(path) && path.endsWith(".py")).map((path) => ({ path, sha256: hash(git(root, ["show", `${candidateSha}:${path}`])), changedLines: changedRanges(root, baseSha, candidateSha, path) })),
    externalGates: ["front-risk-coverage", "front-risk-mutation", "deploy-driver-coverage"],
  };
}

export function loadRiskScope(path, root = ROOT, { verifyWorktree = true } = {}) {
  requireThat(path, "TOKENPROXY_RISK_SCOPE is required");
  const scope = JSON.parse(readFileSync(path, "utf8"));
  const expected = createRiskScope(root, scope.baseSha, scope.candidateSha);
  requireThat(JSON.stringify(scope) === JSON.stringify(expected), "risk scope differs from Git-derived inventory");
  if (verifyWorktree) {
    requireThat(git(root, ["rev-parse", "HEAD"]).trim() === scope.candidateSha, "risk candidate differs from checkout HEAD");
    for (const file of [...scope.files, ...scope.pythonFiles]) requireThat(hash(readFileSync(resolve(root, file.path))) === file.sha256, `risk source differs from candidate: ${file.path}`);
  }
  return scope;
}

export function verifyCandidateSource(root, candidateSha) {
  requireThat(git(root, ["rev-parse", "HEAD"]).trim() === candidateSha, "native verifier checkout does not match candidate");
  requireThat(!git(root, ["status", "--porcelain", "--untracked-files=all", "--", "src", "scripts", "open-sse", "package.json", "package-lock.json"]).trim(), "native verifier source has uncommitted changes");
}

function reportFiles(report, root) {
  const found = new Map();
  for (const [path, file] of Object.entries(report)) {
    const absolute = resolve(root, path);
    requireThat(!found.has(absolute), `duplicate report file: ${path}`);
    found.set(absolute, file);
  }
  return found;
}

export function validateCoverage(report, scope, root = ROOT) {
  const files = reportFiles(report, root);
  const rows = scope.files.map(({ path, changedLines }) => {
    const file = files.get(resolve(root, path));
    requireThat(file && file.b && file.branchMap && file.s && file.statementMap, `coverage missing instrumented file: ${path}`);
    requireThat(Object.keys(file.b).sort().join() === Object.keys(file.branchMap).sort().join(), `coverage branch inventory mismatch: ${path}`);
    requireThat(Object.keys(file.s).length > 0 && Object.keys(file.s).sort().join() === Object.keys(file.statementMap).sort().join(), `coverage contains no executable statements or incomplete mapping: ${path}`);
    requireThat(Object.values(file.s).every((count) => Number.isInteger(count) && count >= 0), `invalid statement counters: ${path}`);
    for (const [id, branches] of Object.entries(file.b)) requireThat(Array.isArray(file.branchMap[id].locations) && file.branchMap[id].locations.length === branches.length, `coverage branch locations mismatch: ${path}`);
    const counts = Object.values(file.b).flatMap((branches) => {
      requireThat(Array.isArray(branches) && branches.length > 0, `invalid branch counters: ${path}`);
      return branches;
    });
    requireThat(counts.every((count) => Number.isInteger(count) && count >= 0), `invalid coverage count: ${path}`);
    const changedCounts = [];
    const selectedBranchIds = [];
    for (const [id, branch] of Object.entries(file.branchMap)) {
      const locations = [branch.loc, ...branch.locations].filter(Boolean);
      requireThat(locations.length > 0 && locations.every((location) => Number.isInteger(location.start?.line) && Number.isInteger(location.end?.line) && location.end.line >= location.start.line), `invalid branch location: ${path}#${id}`);
      const intersects = locations.some((location) => changedLines.some((range) => location.start.line <= range.end && location.end.line >= range.start));
      if (intersects) { selectedBranchIds.push(id); changedCounts.push(...file.b[id]); }
    }
    const covered = changedCounts.filter((count) => count > 0).length;
    return {
      path, changedLines, selectedBranchIds, branches: changedCounts.length, covered,
      percentage: changedCounts.length ? covered / changedCounts.length * 100 : null,
      wholeFile: { branches: counts.length, covered: counts.filter((count) => count > 0).length },
    };
  });
  const total = rows.reduce((sum, row) => sum + row.branches, 0);
  const covered = rows.reduce((sum, row) => sum + row.covered, 0);
  requireThat(total > 0, "coverage contains no branches in the risk scope");
  const percentage = covered / total * 100;
  requireThat(percentage >= 90, `changed risk branch coverage below 90% (${percentage})`);
  return { files: rows, branches: total, covered, percentage };
}

export function mutantFingerprint(path, mutant) {
  return hash(JSON.stringify({ path, id: mutant.id, mutatorName: mutant.mutatorName, location: mutant.location, replacement: mutant.replacement }));
}

export function validatePythonCoverage(report, scope, root = ROOT) {
  requireThat(report.meta?.branch_coverage === true, "deploy-driver report did not enable branch coverage");
  const files = reportFiles(report.files || {}, root);
  const rows = scope.pythonFiles.map(({ path, changedLines }) => {
    const file = files.get(resolve(root, path));
    requireThat(file && Array.isArray(file.executed_branches) && Array.isArray(file.missing_branches), `Python branch coverage missing: ${path}`);
    const arcs = [...file.executed_branches.map((arc) => ({ arc, covered: true })), ...file.missing_branches.map((arc) => ({ arc, covered: false }))];
    const seen = new Set();
    for (const { arc } of arcs) {
      requireThat(Array.isArray(arc) && arc.length === 2 && arc.every(Number.isInteger) && !seen.has(arc.join(",")), `invalid Python branch arc: ${path}`);
      seen.add(arc.join(","));
    }
    const selected = arcs.filter(({ arc }) => changedLines.some((range) => arc.some((line) => line >= range.start && line <= range.end)));
    return { path, branches: selected.length, covered: selected.filter(({ covered }) => covered).length, wholeFileBranches: arcs.length };
  });
  const branches = rows.reduce((sum, row) => sum + row.branches, 0);
  const covered = rows.reduce((sum, row) => sum + row.covered, 0);
  requireThat(branches > 0, "deploy-driver coverage has no changed branches");
  const percentage = covered / branches * 100;
  requireThat(percentage >= 90, `changed deploy-driver branch coverage below 90% (${percentage})`);
  return { files: rows, branches, covered, percentage };
}

export function validateMutation(report, scope, reviews, reportHash, root = ROOT) {
  requireThat(reviews?.candidateSha === scope.candidateSha && reviews?.reportSha256 === reportHash, "mutation review must bind candidate and exact report hash");
  requireThat(Array.isArray(reviews.mutants), "mutation reviews missing");
  const reviewMap = new Map();
  for (const review of reviews.mutants) {
    requireThat(SHA256.test(review.fingerprint) && !reviewMap.has(review.fingerprint), "duplicate or invalid mutant review");
    requireThat(typeof review.reviewer === "string" && review.reviewer.trim() && typeof review.reason === "string" && review.reason.trim(), "mutant review requires reviewer and reasoning");
    requireThat(["equivalent", "accepted-risk", "invalid-mutant"].includes(review.disposition), "surviving mutant is unresolved");
    requireThat(review.disposition !== "accepted-risk" || (typeof review.issue === "string" && review.issue.trim()), "accepted mutant risk requires a tracked issue");
    reviewMap.set(review.fingerprint, review);
  }
  const files = reportFiles(report.files || {}, root);
  const totals = { detected: 0, undetected: 0, ignored: 0, compileError: 0 };
  const usedReviews = new Set();
  const ids = new Set();
  for (const { path, sha256 } of scope.files) {
    const file = files.get(resolve(root, path));
    requireThat(file && typeof file.source === "string" && hash(file.source) === sha256 && Array.isArray(file.mutants), `mutation missing exact source: ${path}`);
    for (const mutant of file.mutants) {
      requireThat(typeof mutant.id === "string" && !ids.has(mutant.id), "duplicate or invalid mutant ID");
      ids.add(mutant.id);
      if (["Killed", "Timeout"].includes(mutant.status)) totals.detected += 1;
      else if (["Survived", "NoCoverage", "Ignored", "CompileError"].includes(mutant.status)) {
        if (["Survived", "NoCoverage"].includes(mutant.status)) totals.undetected += 1;
        else if (mutant.status === "Ignored") totals.ignored += 1;
        else totals.compileError += 1;
        const fingerprint = mutantFingerprint(path, mutant);
        requireThat(reviewMap.has(fingerprint), `unreviewed ${mutant.status} mutant: ${path}#${mutant.id}`);
        requireThat(mutant.status !== "CompileError" || reviewMap.get(fingerprint).disposition === "invalid-mutant", "compile-error exclusion needs explicit invalid-mutant review");
        requireThat(mutant.status === "CompileError" || reviewMap.get(fingerprint).disposition !== "invalid-mutant", "valid mutant cannot use invalid-mutant disposition");
        usedReviews.add(fingerprint);
      } else requireThat(false, `incomplete or invalid mutant status: ${mutant.status}`);
    }
  }
  requireThat(usedReviews.size === reviewMap.size, "mutation review includes stale or unrelated entries");
  const denominator = totals.detected + totals.undetected;
  requireThat(denominator > 0, "mutation report has no completed valid mutants");
  const score = totals.detected / denominator * 100;
  requireThat(score >= 60, `mutation score below 60% (${score})`);
  return { ...totals, score, reviewed: usedReviews.size };
}

function main(argv) {
  requireThat(argv.length === 6 && argv[0] === "--base-sha" && argv[2] === "--candidate-sha" && argv[4] === "--output", "usage: risk-scope.mjs --base-sha <full-sha> --candidate-sha <full-sha> --output <new-file>");
  const scope = createRiskScope(ROOT, argv[1], argv[3]);
  writeFileSync(resolve(argv[5]), `${JSON.stringify(scope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`risk scope contains ${scope.files.length} JavaScript files and ${scope.separateLanguageGates.length} separate-language paths`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
