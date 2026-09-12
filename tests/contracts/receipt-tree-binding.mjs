import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const OWNED_SOURCE_PATHS = Object.freeze([
  "open-sse/translator/formats/openai.js",
  "open-sse/translator/request/openai-responses.js",
  "open-sse/utils/usageTracking.js",
  "src/app/api/v1/responses/route.js",
  "src/sse/handlers/chat.js",
  "tests/contracts",
  "tests/translator/capability-cli-authorization.test.js",
  "tests/translator/capability-stream-contract.test.js",
  "tests/translator/provider-stub-contract.test.js",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Bind a receipt to a committed, clean T07 source tree while permitting unrelated work. */
export function cleanOwnedTreeBinding(root) {
  const args = ["--", ...OWNED_SOURCE_PATHS];
  const tracked = git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", ...args]);
  const staged = git(root, ["diff", "--cached", "--binary", "--no-ext-diff", ...args]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", ...args]).trim().split("\n").filter(Boolean);
  if (tracked || staged || untracked.length) throw new Error(`T07 owned source must be clean before a matrix receipt: ${JSON.stringify({ tracked: !!tracked, staged: !!staged, untracked })}`);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  return {
    head,
    tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    ownedSourcePaths: OWNED_SOURCE_PATHS,
    trackedDiffSha256: sha256(tracked),
    stagedDiffSha256: sha256(staged),
    untrackedOwned: untracked,
  };
}
