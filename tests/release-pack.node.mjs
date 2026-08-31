import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReleasePackage } from "../scripts/release-pack.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-cg-release-pack-test-"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "release-pack-fixture",
    version: "1.2.3",
    files: ["index.js"],
  }, null, 2)}\n`);
  await writeFile(join(root, "index.js"), "export const value = 1;\n");
  git(["init"], root);
  git(["config", "user.name", "Release Pack Test"], root);
  git(["config", "user.email", "release-pack@example.invalid"], root);
  git(["add", "package.json", "index.js"], root);
  git(["commit", "-m", "fixture"], root);
  return root;
}

test("builds a deterministic tgz whose manifest binds the exact Git HEAD", async () => {
  const root = await fixture();
  const firstDir = join(root, "..", `${root.split(/[/\\]/).at(-1)}-out-a`);
  const secondDir = join(root, "..", `${root.split(/[/\\]/).at(-1)}-out-b`);
  try {
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    const first = await buildReleasePackage({ source: root, outputDir: firstDir });
    const second = await buildReleasePackage({ source: root, outputDir: secondDir });
    assert.equal(first.gitHead, git(["rev-parse", "HEAD"], root));
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.fileCount, 2);
    assert.match(await readFile(join(firstDir, "SHA256SUMS.txt"), "utf8"), new RegExp(`^${first.sha256}  release-pack-fixture-1\\.2\\.3\\.tgz\\n$`));
    const record = JSON.parse(await readFile(join(firstDir, "release-artifact.json"), "utf8"));
    assert.deepEqual(record, first);
  } finally {
    await Promise.all([root, firstDir, secondDir].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("rejects a dirty source tree", async () => {
  const root = await fixture();
  const outputDir = join(root, "..", `${root.split(/[/\\]/).at(-1)}-dirty-out`);
  try {
    await writeFile(join(root, "index.js"), "export const value = 2;\n");
    await assert.rejects(
      () => buildReleasePackage({ source: root, outputDir }),
      /clean Git worktree/,
    );
  } finally {
    await Promise.all([root, outputDir].map((path) => rm(path, { recursive: true, force: true })));
  }
});
