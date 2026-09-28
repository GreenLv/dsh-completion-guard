#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function command(name) {
  return process.platform === "win32" && name === "npm" ? "npm.cmd" : name;
}

function run(name, args, cwd, env = process.env) {
  const options = { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  if (process.platform === "win32" && name === "npm") options.shell = true;
  return execFileSync(command(name), args, options).trim();
}

function pack(source, destination, cache) {
  const env = { ...process.env, npm_config_cache: cache };
  const output = run("npm", ["pack", source, "--ignore-scripts", "--json", "--pack-destination", destination], source, env);
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed) && parsed.length === 1, "npm pack must return exactly one package record");
  return parsed[0];
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Normalize staged file permissions: the tar must not inherit the packing
 * host's working-tree modes, or the same clean HEAD packs different bytes on
 * a machine where files happen to be 0600. Executable bits come from the Git
 * index (mode 100755); every other file is 0644 and every directory 0755, so
 * the same HEAD is byte-identical regardless of source permissions.
 */
export async function normalizeStagedModes(stagedRoot, execPaths) {
  const walk = async (directory, relative) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await chmod(path, 0o755);
        await walk(path, rel);
      } else if (entry.isFile()) {
        await chmod(path, execPaths.has(rel) ? 0o755 : 0o644);
      }
    }
  };
  await walk(stagedRoot, "");
}

function parseArgs(argv) {
  const result = { source: process.cwd(), outputDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    assert(flag === "--source" || flag === "--output-dir", `unknown argument: ${flag}`);
    const value = argv[index + 1];
    assert(value, `${flag} requires a value`);
    if (flag === "--source") result.source = value;
    else result.outputDir = value;
    index += 1;
  }
  assert(result.outputDir, "--output-dir is required");
  return result;
}

const USTAR_MTIME = 499137300; // 1985-10-26T08:15:00Z, before every real source mtime

function tarChecksum(block) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : block[index];
  }
  return `${sum.toString(8).padStart(7, "0")}\0`;
}

function ustarHeader(path, size, mode) {
  assert(Buffer.byteLength(path) <= 100, `ustar member path too long: ${path}`);
  const block = Buffer.alloc(512);
  block.write(path, 0);
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write(`${USTAR_MTIME.toString(8).padStart(11, "0")}\0`, 136);
  block.write("        ", 148);
  block[156] = 0x30;
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(tarChecksum(block), 148);
  return block;
}

/**
 * Deterministic ustar+gzip bytes for one extracted package tree: fixed
 * metadata, git-index executable bits, sorted file order, node:zlib framing.
 */
async function canonicalTarGzip(extractedRoot) {
  const packageRoot = join(extractedRoot, "package");
  const files = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`unexpected non-regular package member: ${path}`);
    }
  };
  await walk(packageRoot);
  files.sort();
  const chunks = [];
  for (const file of files) {
    const member = relative(packageRoot, file).split(sep).join("/");
    const bytes = await readFile(file);
    const { mode } = await stat(file);
    chunks.push(ustarHeader(`package/${member}`, bytes.length, mode & 0o755 === 0o755 ? 0o755 : 0o644));
    chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export async function buildReleasePackage({ source, outputDir }) {
  const root = await realpath(resolve(source));
  const destination = resolve(outputDir);
  assert(destination !== root && !destination.startsWith(`${root}${sep}`), "output directory must be outside the source tree");
  if (process.platform === "win32") {
    assert(!/[&|<>^%\r\n]/.test(root) && !/[&|<>^%\r\n]/.test(destination),
      "Windows release paths must not contain shell-control characters");
  }
  const topLevel = await realpath(resolve(run("git", ["rev-parse", "--show-toplevel"], root)));
  assert(topLevel === root, "source must be the Git repository root");
  const gitHead = run("git", ["rev-parse", "--verify", "HEAD"], root);
  assert(/^[0-9a-f]{40}$/.test(gitHead), "Git HEAD must be a full lowercase SHA-1");
  assert(run("git", ["status", "--porcelain=v1"], root) === "", "release packaging requires a clean Git worktree");

  const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert(typeof sourceManifest.name === "string" && sourceManifest.name.length > 0, "package name is required");
  assert(typeof sourceManifest.version === "string" && sourceManifest.version.length > 0, "package version is required");
  await mkdir(destination, { recursive: true });
  const target = join(destination, `${sourceManifest.name}-${sourceManifest.version}.tgz`);
  try {
    await stat(target);
    throw new Error(`refusing to overwrite existing release artifact: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const scratch = await mkdtemp(join(tmpdir(), "dsh-completion-guard-release-pack-"));
  try {
    const seedDir = join(scratch, "seed");
    const unpackDir = join(scratch, "unpack");
    const firstDir = join(scratch, "first");
    const secondDir = join(scratch, "second");
    const cacheDir = join(scratch, "npm-cache");
    await Promise.all([seedDir, unpackDir, firstDir, secondDir, cacheDir].map((path) => mkdir(path)));

    const seed = pack(root, seedDir, cacheDir);
    const seedPath = join(seedDir, seed.filename);
    run("tar", ["-xzf", seed.filename, "-C", "../unpack"], seedDir);
    const stagedRoot = join(unpackDir, "package");
    const stagedManifestPath = join(stagedRoot, "package.json");
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"));
    assert(stagedManifest.name === sourceManifest.name && stagedManifest.version === sourceManifest.version,
      "staged package identity differs from source manifest");
    assert(stagedManifest.gitHead === undefined || stagedManifest.gitHead === gitHead,
      "staged package contains a conflicting gitHead");
    stagedManifest.gitHead = gitHead;
    await writeFile(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, "utf8");
    const execPaths = new Set(run("git", ["ls-files", "-s"], root)
      .split("\n")
      .filter((line) => line.startsWith("100755 "))
      .map((line) => line.split("\t").pop() ?? "")
      .filter(Boolean));
    await normalizeStagedModes(stagedRoot, execPaths);

    const first = pack(stagedRoot, firstDir, cacheDir);
    const second = pack(stagedRoot, secondDir, cacheDir);
    assert(first.filename === second.filename, "repeated packs produced different filenames");
    assert(first.files.length === seed.files.length && second.files.length === seed.files.length,
      "gitHead staging changed the package file count");
    const firstPath = join(firstDir, first.filename);
    const secondPath = join(secondDir, second.filename);
    const [firstDigest, secondDigest] = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    assert(firstDigest === secondDigest, "repeated release packs are not byte-identical");

    const verifyDir = join(scratch, "verify");
    await mkdir(verifyDir);
    run("tar", ["-xzf", first.filename, "-C", "../verify"], firstDir);
    const publishedManifest = JSON.parse(await readFile(join(verifyDir, "package", "package.json"), "utf8"));
    assert(publishedManifest.name === sourceManifest.name, "release package name mismatch");
    assert(publishedManifest.version === sourceManifest.version, "release package version mismatch");
    assert(publishedManifest.gitHead === gitHead, "release package gitHead mismatch");

    // npm pack compresses with the host's tar/gzip, whose tar flavor and
    // deflate framing differ between operating systems even for identical
    // file bytes (verified: same members, different tgz sha256 on macOS vs
    // Ubuntu). Build the ustar stream in node with fixed metadata and
    // compress with node:zlib so the published tgz is byte-identical on
    // every host.
    const recompressed = await canonicalTarGzip(verifyDir);
    await writeFile(target, recompressed);
    await writeFile(join(destination, "SHA256SUMS.txt"), `${createHash("sha256").update(recompressed).digest("hex")}  ${basename(target)}\n`, "utf8");
    const result = {
      name: sourceManifest.name,
      version: sourceManifest.version,
      gitHead,
      filename: basename(target),
      sha256: createHash("sha256").update(recompressed).digest("hex"),
      shasum: first.shasum,
      integrity: first.integrity,
      size: recompressed.length,
      fileCount: first.files.length,
    };
    await writeFile(join(destination, "release-artifact.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await buildReleasePackage(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
