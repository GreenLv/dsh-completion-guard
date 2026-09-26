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

// Test the actual product payload, outside this checkout and its node_modules.
// This is a disposable pack regression, never a release/canonical candidate.
test("packed standalone entries start without host peers or repository resolution", async () => {
  const { cp, readdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const scratch = await mkdtemp(join(tmpdir(), "guard-packed-no-peers-"));
  try {
    const root = join(scratch, "source"); await mkdir(root);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const name of ["package.json", ...manifest.files]) await cp(join(source, name), join(root, name), { recursive: true });
    git(["init"], root); git(["config", "user.name", "Packed Entry Test"], root);
    git(["config", "user.email", "packed-entry@example.invalid"], root);
    git(["add", "."], root); git(["commit", "-m", "isolated product payload"], root);
    const output = join(scratch, "packed");
    const artifact = await buildReleasePackage({ source: root, outputDir: output });
    const unpack = join(scratch, "unpacked"); await mkdir(unpack);
    execFileSync("tar", ["-xf", join(output, artifact.filename), "-C", unpack]);
    const packageRoot = join(unpack, "package");
    assert.ok(!(await readdir(packageRoot)).includes("node_modules"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_PATH|NODE_OPTIONS)$/i.test(key)));
    const run = (args) => spawnSync(process.execPath, args, { cwd: unpack, env, encoding: "utf8" });
    // '.' is the Cordis host plugin, not a standalone entry. New exports must
    // be explicitly classified, so a newly introduced CLI surface cannot hide.
    assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./domain"]);
    const absence = run(["--input-type=module", "-e", `import {createRequire} from 'node:module'; try {createRequire(${JSON.stringify(join(packageRoot, "package.json"))}).resolve('@deepseek-ai/dsh-session'); process.exit(9)} catch(e) {if(e.code !== 'MODULE_NOT_FOUND') throw e}`]);
    assert.equal(absence.status, 0, "fixture must have no resolvable host peer: " + absence.stderr);
    const domain = pathToFileURL(join(packageRoot, manifest.exports["./domain"].default)).href;
    const imported = run(["--input-type=module", "-e", `const d = await import(${JSON.stringify(domain)}); console.log(d.evaluateHostLock([]).status)`]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), "unavailable");
    for (const bin of Object.values(manifest.bin)) {
      for (const command of ["inspect", "inspect-graph", "inject", "verify-dump"]) {
        const result = run([join(packageRoot, bin), command, "--runtime-root", join(scratch, "absent-runtime"), "--profile-root", join(scratch, "absent-profile"), "--dump-config", join(scratch, "absent-dump")]);
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
        assert.equal(JSON.parse(result.stderr.trim()).status, "unavailable", result.stderr);
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
