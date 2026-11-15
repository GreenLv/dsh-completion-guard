import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderReleaseNotes } from "../scripts/release-notes.mjs";

const version = "1.2.3-rc.1";
const english = `# Changelog\n\n## ${version}\n\n### Changes\n\n- Keep [instructions](docs/GUIDE.md#start) and [external](https://example.invalid/).\n\n### Upgrading\n\nRetain the original evidence.\n\n## 1.2.2\n\nOlder English content.\n`;
const chinese = `# 更新日志\n\n## ${version}\n\n### 变更\n\n- 保留[操作说明](docs/GUIDE.md#start)。\n\n### 升级步骤与兼容性\n\n保留原证据。\n\n## 1.2.2\n\n旧中文内容。\n`;
const render = (overrides = {}) => renderReleaseNotes({ version, english, chinese, ...overrides });

test("preserves the full prerelease version, language order, content and versioned links", () => {
  const notes = render();
  assert.equal(notes.name, "DCG 1.2.3-rc.1");
  assert.equal(notes.tag, "v1.2.3-rc.1");
  assert.equal(notes.previous, "1.2.2");
  assert.ok(notes.body.startsWith("## Changes\n"));
  assert.ok(notes.body.indexOf("### Upgrading") < notes.body.indexOf("## 变更"));
  assert.match(notes.body, /blob\/v1\.2\.3-rc\.1\/docs\/GUIDE\.md#start/);
  assert.match(notes.body, /\[external\]\(https:\/\/example\.invalid\/\)/);
  assert.match(notes.body, /compare\/v1\.2\.2\.\.\.v1\.2\.3-rc\.1/);
  assert.match(notes.body, /Retain the original evidence/);
  assert.match(notes.body, /保留原证据/);
  assert.doesNotMatch(notes.body, /Older English|旧中文内容/);
  assert.deepEqual(render({ english: english.replaceAll("\n", "\r\n"), chinese: chinese.replaceAll("\n", "\r\n") }), notes);
});

test("refuses missing or duplicate versions and mismatched bilingual history", () => {
  assert.throws(() => render({ chinese: chinese.replace(`## ${version}`, "## 1.2.4") }), /exactly one/);
  assert.throws(() => render({ english: `${english}\n## ${version}\n` }), /exactly one/);
  assert.throws(() => render({ chinese: chinese.replace("## 1.2.2", "## 1.2.1") }), /preceding release/);
});

test("refuses incomplete, reordered and empty release sections", () => {
  assert.throws(() => render({ english: english.replace("### Upgrading", "### Validation") }), /ordered sections/);
  assert.throws(() => render({ english: english.replace("### Changes", "### Upgrading").replace("### Upgrading\n\nRetain", "### Changes\n\nRetain") }), /ordered sections/);
  assert.throws(() => render({ english: english.replace("Retain the original evidence.", "") }), /Empty release section/);
});

test("rejects invalid versions and relative links escaping the release source", () => {
  assert.throws(() => render({ version: "v1.2.3" }), /complete version/);
  assert.throws(() => render({ version: "1.2.3-rc.01" }), /complete version/);
  assert.throws(() => render({ english: english.replace("docs/GUIDE.md#start", "../private.md") }), /stay inside/);
});

test("preserves fenced and inline code and ignores example version headings", () => {
  const example = '\n```md\n## 9.9.9\n### Upgrading\n[literal](docs/code.md)\n```\nUse ``[literal](docs/code.md)`` verbatim.\n';
  const notes = render({ english: english.replace("Retain the original evidence.", "Retain the original evidence." + example), chinese: chinese.replace("保留原证据。", "保留原证据。" + example) });
  assert.equal(notes.previous, "1.2.2");
  assert.ok(notes.body.includes(example));
  assert.doesNotMatch(notes.body, /blob\/v1\.2\.3-rc\.1\/docs\/code/);
  assert.match(notes.body, /保留原证据/);
});

test("pins angle-bracket, balanced-parenthesis and code-label inline links", () => {
  const links = '[space](<docs/Guide With Spaces.md>) [parenthesis](docs/Guide(v2).md) [`command`](docs/cmd.md)';
  const notes = render({ english: english.replace("Retain the original evidence.", links) });
  assert.match(notes.body, /\[space\]\(<https:\/\/github\.com\/GreenLv\/dsh-completion-guard\/blob\/v1\.2\.3-rc\.1\/docs\/Guide%20With%20Spaces\.md>\)/);
  assert.match(notes.body, /docs\/Guide\(v2\)\.md\)/);
  assert.match(notes.body, /\[`command`\]\(https:\/\/github\.com\/GreenLv\/dsh-completion-guard\/blob\/v1\.2\.3-rc\.1\/docs\/cmd\.md\)/);
});

test("refuses reference definitions instead of leaking labels across languages", () => {
  assert.throws(() => render({ english: english.replace("Retain the original evidence.", "Read [guide][x].\n\n[x]: docs/GUIDE.md") }), /inline links instead/);
  for (const reference of ["[Guide][guide]", "[Guide][]", "[Guide]"]) {
    const withReference = english.replace("Retain the original evidence.", reference);
    assert.throws(() => render({ english: withReference + "\n[guide]: docs/GUIDE.md\n" }), /inline links instead/);
    assert.throws(() => render({ english: withReference, chinese: chinese + "\n[guide]: docs/GUIDE.md\n" }), /inline links instead/);
  }
});

test("preserves escaped bracket literals while pinning links beside escaped backticks", () => {
  const slash = String.fromCharCode(92);
  const literal = `${slash}[literal](docs/literal.md) and ${slash}`;
  const prose = literal + "` [real](docs/real.md) " + slash + "`";
  const notes = render({ english: english.replace("Retain the original evidence.", prose) });
  assert.ok(notes.body.includes(literal));
  assert.doesNotMatch(notes.body, /blob\/v1\.2\.3-rc\.1\/docs\/literal/);
  assert.match(notes.body, /blob\/v1\.2\.3-rc\.1\/docs\/real\.md/);
});

test("build metadata uses the GitHub heading anchor without plus or dots", () => {
  const buildVersion = "1.2.3+build.4";
  const notes = render({ version: buildVersion, english: english.replaceAll(version, buildVersion), chinese: chinese.replaceAll(version, buildVersion) });
  assert.equal(notes.name, "DCG 1.2.3+build.4");
  assert.match(notes.body, /CHANGELOG\.md#123build4/);
  assert.doesNotMatch(notes.body, /#123\+build4/);
});

test("CLI defaults to package version and cannot overwrite frozen notes or write into the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcg-release-notes-"));
  const source = join(root, "source");
  const output = join(root, "notes");
  const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/release-notes.mjs");
  try {
    await mkdir(source);
    await Promise.all([
      writeFile(join(source, "package.json"), JSON.stringify({ version })),
      writeFile(join(source, "CHANGELOG.md"), english),
      writeFile(join(source, "CHANGELOG.zh-CN.md"), chinese),
    ]);
    execFileSync(process.execPath, [cli, "--source", source, "--output-dir", output]);
    const first = await readFile(join(output, "release-fields.json"));
    assert.deepEqual(JSON.parse(first), { name: "DCG 1.2.3-rc.1", body: render().body });
    const duplicate = spawnSync(process.execPath, [cli, "--source", source, "--output-dir", output], { encoding: "utf8" });
    assert.equal(duplicate.status, 1);
    assert.deepEqual(await readFile(join(output, "release-fields.json")), first);
    const inside = spawnSync(process.execPath, [cli, "--source", source, "--output-dir", join(source, "notes")], { encoding: "utf8" });
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /outside the source checkout/);
    const alias = join(root, "source-alias");
    await symlink(source, alias, "junction");
    const aliasedOutput = spawnSync(process.execPath, [cli, "--source", source, "--output-dir", join(alias, "new-parent", "notes")], { encoding: "utf8" });
    assert.equal(aliasedOutput.status, 1);
    assert.match(aliasedOutput.stderr, /outside the source checkout/);
    await assert.rejects(access(join(source, "new-parent")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI terminates for an unavailable Windows output drive", { skip: process.platform !== "win32" }, async (context) => {
  let absent;
  for (const drive of ["Z", "Y", "X", "W", "V", "U"]) {
    try { await access(`${drive}:\\`); }
    catch (error) { if (error.code === "ENOENT") { absent = drive; break; } }
  }
  if (!absent) { context.skip("No unavailable drive among the probe candidates"); return; }
  const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/release-notes.mjs");
  const result = spawnSync(process.execPath, [cli, "--output-dir", `${absent}:\\dcg-release-notes-unused\\notes`], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, "CLI must exit rather than time out");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});
