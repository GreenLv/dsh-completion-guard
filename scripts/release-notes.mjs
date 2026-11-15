import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPOSITORY = "https://github.com/GreenLv/dsh-completion-guard";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function requireVersion(value) {
  const match = typeof value === "string" && VERSION.exec(value);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("Use a complete version without a leading v");
  }
  return value;
}

function fencedRanges(markdown) {
  const ranges = [];
  let opening;
  for (const line of markdown.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line[0]);
    if (!fence) continue;
    if (!opening && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      opening = { start: line.index, marker: fence[1][0], length: fence[1].length };
    } else if (opening && fence[1][0] === opening.marker && fence[1].length >= opening.length && !fence[2].trim()) {
      ranges.push([opening.start, line.index + line[0].length]);
      opening = undefined;
    }
  }
  if (opening) ranges.push([opening.start, markdown.length]);
  return ranges;
}

function mask(markdown, ranges) {
  let output = "", cursor = 0;
  for (const [start, end] of ranges) {
    output += markdown.slice(cursor, start) + markdown.slice(start, end).replace(/[^\n]/g, " ");
    cursor = end;
  }
  return output + markdown.slice(cursor);
}

function escaped(markdown, index) {
  let count = 0;
  while (index > 0 && markdown[--index] === "\\") count++;
  return count % 2 === 1;
}

function codeRanges(markdown) {
  const blocks = fencedRanges(markdown), ranges = [...blocks];
  let begin = 0;
  for (const [boundary, end] of [...blocks, [markdown.length, markdown.length]]) {
    let cursor = begin;
    while (cursor < boundary) {
      const start = markdown.indexOf("`", cursor);
      if (start < 0 || start >= boundary) break;
      let width = 1;
      while (markdown[start + width] === "`") width++;
      if (escaped(markdown, start)) { cursor = start + width; continue; }
      let closing = start + width;
      while (closing < boundary) {
        closing = markdown.indexOf("`", closing);
        if (closing < 0 || closing >= boundary) break;
        let length = 1;
        while (markdown[closing + length] === "`") length++;
        if (length === width) { ranges.push([start, closing + width]); break; }
        closing += length;
      }
      cursor = closing >= start + width && closing < boundary ? closing + width : start + width;
    }
    begin = end;
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function entry(markdown, version, headings) {
  const visible = mask(markdown, fencedRanges(markdown));
  const headers = [...visible.matchAll(/^## (.+)$/gm)];
  const versionOf = (header) => header[1].match(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0];
  const matches = headers.map((header, index) => ({ header, index }))
    .filter(({ header }) => versionOf(header) === version);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${version} entry in each changelog`);
  const { header, index } = matches[0];
  if (header[1] !== version) throw new Error("New release entries must use a plain ## <version> heading");
  const body = markdown.slice(header.index + header[0].length, headers[index + 1]?.index).trim();
  const bodyVisible = mask(body, fencedRanges(body));
  const sectionMatches = [...bodyVisible.matchAll(/^### (.+)$/gm)];
  const sections = sectionMatches.map((match) => match[1]);
  if (JSON.stringify(sections) !== JSON.stringify(headings) || /^#{1,2} /m.test(bodyVisible)
    || !body.startsWith(`### ${headings[0]}\n`)) {
    throw new Error(`Expected ordered sections: ${headings.join("; ")}`);
  }
  for (let i = 0; i < headings.length; i++) {
    const content = body.slice(sectionMatches[i].index + sectionMatches[i][0].length, sectionMatches[i + 1]?.index).trim();
    if (!content) throw new Error(`Empty release section: ${headings[i]}`);
  }
  const previous = headers.slice(index + 1).map(versionOf).find(Boolean);
  if (!previous) throw new Error("A preceding release is required for the source comparison link");
  requireVersion(previous);
  return { body: body.replace(`### ${headings[0]}`, `## ${headings[0]}`), previous };
}

function pinDestination(target, version) {
    if (/^(https?:|mailto:|#)/i.test(target)) return target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\")
      || target.split(/[?#]/)[0].split("/").includes("..")) {
      throw new Error("Relative release links must stay inside the versioned repository");
    }
    if (!target) throw new Error("Release links need an explicit destination");
    const base = new URL(`${REPOSITORY}/blob/v${encodeURIComponent(version)}/`);
    const pinned = new URL(target, base);
    if (!pinned.pathname.startsWith(base.pathname)) throw new Error("Release links must stay inside the versioned repository");
    return pinned.href;
}

function pinProse(markdown, version, visible, offset) {
  let output = "", cursor = 0, search = 0;
  while (true) {
    const marker = markdown.indexOf("](", search);
    if (marker < 0) break;
    const globalMarker = offset + marker;
    let depth = 1, label = globalMarker - 1;
    if (!escaped(visible, globalMarker)) {
      for (; label >= 0; label--) {
        if (escaped(visible, label)) continue;
        if (visible[label] === "]") depth++;
        if (visible[label] === "[" && !--depth) break;
      }
    }
    if (depth) { search = marker + 2; continue; }
    let start = marker + 2;
    while (/\s/.test(markdown[start] ?? "") && start < markdown.length) start++;
    let end, after;
    if (markdown[start] === "<") {
      start++;
      end = markdown.indexOf(">", start);
      if (end < 0 || /[\n<]/.test(markdown.slice(start, end))) throw new Error("Unsupported angle-bracket link destination");
      after = end + 1;
    } else {
      end = start;
      let nesting = 0;
      for (; end < markdown.length; end++) {
        const char = markdown[end];
        if (char === "\\") throw new Error("Use URL-encoded link destinations");
        if (char === "(") nesting++;
        else if (char === ")") { if (!nesting) break; nesting--; }
        else if (/\s/.test(char)) break;
      }
      if (nesting) throw new Error("Unbalanced link destination");
      after = end;
    }
    const suffix = /^\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))\s*)?\)/.exec(markdown.slice(after));
    if (!suffix) throw new Error("Unsupported inline link syntax");
    output += markdown.slice(cursor, start) + pinDestination(markdown.slice(start, end), version);
    cursor = end;
    search = after + suffix[0].length;
  }
  return output + markdown.slice(cursor);
}

function pinLinks(markdown, version, definitions) {
  const ranges = codeRanges(markdown), visible = mask(markdown, ranges);
  // Separate language blocks must never share reference-definition labels.
  // The house format uses inline links; reject unsupported forms explicitly.
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(visible)) throw new Error("Use inline links instead of reference definitions");
  for (const match of visible.matchAll(/\[([^\]\n]+)\](?:\s*\[[^\]\n]*\])?/g)) {
    if (escaped(visible, match.index)) continue;
    const label = match[1].trim().replace(/\s+/g, " ").toUpperCase();
    const explicitReference = match[0].endsWith("]") && match[0].slice(match[1].length + 2).trim().startsWith("[");
    if (explicitReference || (definitions.has(label) && visible[match.index + match[0].length] !== "(")) {
      throw new Error("Use inline links instead of reference links, including cross-entry definitions");
    }
  }
  if (/^(?: {4}|\t).*\]\(/m.test(visible)) throw new Error("Use fenced rather than indented code for link examples");
  let output = "", cursor = 0;
  for (const [start, end] of ranges) {
    output += pinProse(markdown.slice(cursor, start), version, visible, cursor) + markdown.slice(start, end);
    cursor = end;
  }
  return output + pinProse(markdown.slice(cursor), version, visible, cursor);
}

export function renderReleaseNotes({ version, english, chinese }) {
  requireVersion(version);
  // Normalize line endings at the source boundary; emitted release bytes use LF.
  const en = entry(english.replace(/\r\n/g, "\n"), version, ["Changes", "Upgrading"]);
  const zh = entry(chinese.replace(/\r\n/g, "\n"), version, ["变更", "升级步骤与兼容性"]);
  if (en.previous !== zh.previous) throw new Error("Both changelogs must agree on the preceding release");
  const definitions = new Set([english, chinese].flatMap((source) => {
    const visible = mask(source, codeRanges(source));
    return [...visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => match[1].trim().replace(/\s+/g, " ").toUpperCase());
  }));
  const anchor = version.toLowerCase().replace(/[.+]/g, "");
  const compare = `${REPOSITORY}/compare/v${en.previous}...v${version}`;
  const enLinks = `See the [changelog](${REPOSITORY}/blob/v${version}/CHANGELOG.md#${anchor}) and [source comparison](${compare}).`;
  const zhLinks = `见[更新日志](${REPOSITORY}/blob/v${version}/CHANGELOG.zh-CN.md#${anchor})和[源码变更](${compare})。`;
  return {
    name: `DCG ${version}`,
    tag: `v${version}`,
    previous: en.previous,
    body: `${pinLinks(en.body, version, definitions)}\n\n${enLinks}\n\n${pinLinks(zh.body, version, definitions)}\n\n${zhLinks}\n`,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string", default: process.cwd() },
    version: { type: "string" },
    "output-dir": { type: "string" },
  } });
  if (!values["output-dir"]) throw new Error("--output-dir must name an unused directory outside the checkout");
  const source = await realpath(resolve(values.source));
  let ancestor = resolve(values["output-dir"]);
  const missing = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const output = resolve(ancestor, ...missing);
  const location = relative(source, output);
  if (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
    throw new Error("--output-dir must be outside the source checkout");
  }
  const [manifest, english, chinese] = await Promise.all([
    readFile(join(source, "package.json"), "utf8"),
    readFile(join(source, "CHANGELOG.md"), "utf8"),
    readFile(join(source, "CHANGELOG.zh-CN.md"), "utf8"),
  ]);
  const version = values.version ?? JSON.parse(manifest).version;
  const notes = renderReleaseNotes({ version, english, chinese });
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  await mkdir(dirname(output), { recursive: true });
  // Never overwrite an earlier frozen note candidate.
  await mkdir(output);
  await writeFile(join(output, "release-notes.md"), notes.body, { flag: "wx" });
  await writeFile(join(output, "release-fields.json"), `${JSON.stringify({ name: notes.name, body: notes.body }, null, 2)}\n`, { flag: "wx" });
  const record = {
    schema: "dcg-release-notes/v1", version, tag: notes.tag, name: notes.name, previous: notes.previous,
    body_sha256: digest(notes.body),
    source_sha256: { "CHANGELOG.md": digest(english), "CHANGELOG.zh-CN.md": digest(chinese) },
  };
  await writeFile(join(output, "release-notes.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ ...record, output_dir: output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
