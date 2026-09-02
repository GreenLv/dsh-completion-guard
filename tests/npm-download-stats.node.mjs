import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildStatsDocument,
  collectPackageSeries,
  latestCompleteUtcDay,
  normalizeRangePayload,
  reconcilePointPayload,
  renderSvg,
  run,
  splitDateRange,
} from "../scripts/npm-download-stats.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/npm-downloads-dual.json", import.meta.url), "utf8"));
const config = {
  schema: 1,
  title: "rename fixture",
  project: "dsh-completion-guard",
  rename: { date: "2026-08-29", label: "renamed to dsh-completion-guard" },
  packages: [
    { package: "dsh-context-guard", label: "dsh-context-guard", color: "#f59e0b", start: "2026-08-26" },
    { package: "dsh-completion-guard", label: "dsh-completion-guard", color: "#2563eb", start: "2026-08-29" },
  ],
};
const collected = [
  { spec: config.packages[0], downloads: fixture.old, sources: [] },
  { spec: config.packages[1], downloads: fixture.new, sources: [] },
];

test("calculates per-package and combined cumulative downloads across the rename", () => {
  const document = buildStatsDocument(config, collected, "2026-08-30T04:37:00.000Z", "2026-08-29");
  assert.equal(document.packages[0].total, 6);
  assert.equal(document.packages[1].total, 4);
  assert.deepEqual(document.project_cumulative.map((item) => item.cumulative), [2, 5, 5, 10]);
  const english = renderSvg(document, "en");
  const chinese = renderSvg(document, "zh-CN");
  for (const svg of [english, chinese]) {
    assert.match(svg, /dsh-context-guard/);
    assert.match(svg, /dsh-completion-guard/);
    assert.match(svg, /2026-08-29/);
    assert.match(svg, /<title id="chart-title">/);
    assert.match(svg, /<desc id="chart-desc">/);
    assert.doesNotMatch(svg, /NaN/);
    const renameY = Number(svg.match(/y="([0-9.]+)"[^>]*class="rename-label"/)?.[1]);
    const endpointY = Number(svg.match(/y="([0-9.]+)"[^>]*class="endpoint"/)?.[1]);
    assert.ok(Math.abs(renameY - endpointY) >= 16, "rename and endpoint labels must not collide");
  }
  assert.match(english, /Cumulative downloads/);
  assert.match(chinese, /累计下载量/);
  assert.match(english, /All available history · 2026-08-26 → 2026-08-29/);
  assert.match(chinese, /全量历史 · 2026-08-26 → 2026-08-29/);
  assert.doesNotMatch(english, /Daily npm downloads/);
  assert.doesNotMatch(chinese, /每日 npm 下载量/);
});

test("shows every x-axis date when all labels fit", () => {
  const document = buildStatsDocument(config, collected, "2026-09-03T04:37:00.000Z", "2026-09-02");
  const svg = renderSvg(document, "en");
  const labels = [...svg.matchAll(/class="axis">(\d{4}-\d{2}-\d{2})<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(labels, [
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
  ]);
});

test("adapts x-axis tick density for long periods without crowding endpoints", () => {
  const document = buildStatsDocument(config, collected, "2026-10-02T04:37:00.000Z", "2026-10-01");
  const svg = renderSvg(document, "en");
  const ticks = [...svg.matchAll(/<text x="([^"]+)" y="464" text-anchor="(start|middle|end)" class="axis">(\d{4}-\d{2}-\d{2})<\/text>/g)].map((match) => {
    const x = Number(match[1]);
    const width = match[3].length * 6.6;
    const left = match[2] === "start" ? x : match[2] === "end" ? x - width : x - width / 2;
    const right = match[2] === "start" ? x + width : match[2] === "end" ? x : x + width / 2;
    return { label: match[3], left, right };
  });
  assert.ok(ticks.length > 5 && ticks.length <= 11);
  assert.equal(ticks[0].label, "2026-08-26");
  assert.equal(ticks.at(-1).label, "2026-10-01");
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index].left - ticks[index - 1].right >= 15.9);
  }
});

test("rejects a rename date outside the rendered period", () => {
  const document = buildStatsDocument({ ...config, rename: { date: "2026-08-30", label: "bad" } }, collected, "2026-08-30T04:37:00.000Z", "2026-08-29");
  assert.throws(() => renderSvg(document), /rename date is outside/);
});

test("splits long UTC ranges without gaps at the leap-year boundary", () => {
  assert.deepEqual(splitDateRange("2024-01-01", "2024-12-31", 365), [
    { start: "2024-01-01", end: "2024-12-30" },
    { start: "2024-12-31", end: "2024-12-31" },
  ]);
});

test("normalizes missing and unordered days but rejects ambiguous range rows", () => {
  const expected = { packageName: "fixture-package", start: "2026-08-26", end: "2026-08-28" };
  const payload = {
    package: "fixture-package",
    start: expected.start,
    end: expected.end,
    downloads: [
      { day: "2026-08-28", downloads: 4 },
      { day: "2026-08-26", downloads: 2 },
    ],
  };
  assert.deepEqual(normalizeRangePayload(payload, expected), [
    { day: "2026-08-26", downloads: 2 },
    { day: "2026-08-27", downloads: 0 },
    { day: "2026-08-28", downloads: 4 },
  ]);
  assert.throws(
    () => normalizeRangePayload({ ...payload, downloads: [...payload.downloads, payload.downloads[0]] }, expected),
    /duplicate range day/,
  );
  assert.throws(
    () => normalizeRangePayload({ ...payload, downloads: [{ day: "2026-08-29", downloads: 1 }] }, expected),
    /outside requested bounds/,
  );
  assert.throws(
    () => normalizeRangePayload({ ...payload, downloads: [{ day: "2026-08-26", downloads: -1 }] }, expected),
    /invalid download count/,
  );
});

test("rejects a point total that differs from the normalized range", () => {
  const expected = { packageName: "fixture-package", start: "2026-08-26", end: "2026-08-27" };
  const daily = [{ day: "2026-08-26", downloads: 2 }, { day: "2026-08-27", downloads: 3 }];
  assert.equal(reconcilePointPayload({ package: "fixture-package", start: expected.start, end: expected.end, downloads: 5 }, expected, daily), 5);
  assert.throws(
    () => reconcilePointPayload({ package: "fixture-package", start: expected.start, end: expected.end, downloads: 4 }, expected, daily),
    /range\/point mismatch/,
  );
});

test("collects a scoped package through encoded range and point URLs", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const payload = url.includes("/range/")
      ? { package: "@scope/fixture", start: "2026-08-29", end: "2026-08-29", downloads: [{ day: "2026-08-29", downloads: 7 }] }
      : { package: "@scope/fixture", start: "2026-08-29", end: "2026-08-29", downloads: 7 };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const result = await collectPackageSeries({ package: "@scope/fixture", label: "fixture", color: "#123abc", start: "2026-08-29" }, "2026-08-29", fetchImpl);
  assert.equal(result.downloads[0].downloads, 7);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.endsWith("/%40scope%2Ffixture")));
});

test("uses the previous UTC calendar day as the default data end", () => {
  assert.equal(latestCompleteUtcDay("2026-09-02T11:10:51.000Z"), "2026-09-01");
  assert.equal(latestCompleteUtcDay("2026-09-02T00:30:00+08:00"), "2026-08-31");
  assert.throws(() => latestCompleteUtcDay("not-a-timestamp"), /generatedAt must be an ISO timestamp/);
});

test("rejects HTTP, JSON, and range-point failures", async () => {
  const spec = { package: "fixture-package", label: "fixture", color: "#123abc", start: "2026-08-29" };
  await assert.rejects(() => collectPackageSeries(spec, "2026-08-29", async () => new Response("unavailable", { status: 503 })), /HTTP 503/);
  await assert.rejects(() => collectPackageSeries(spec, "2026-08-29", async () => new Response("not-json", { status: 200 })), /invalid JSON/);
  await assert.rejects(() => collectPackageSeries(spec, "2026-08-29", async (url) => new Response(JSON.stringify(
    url.includes("/range/")
      ? { package: "fixture-package", start: "2026-08-29", end: "2026-08-29", downloads: [{ day: "2026-08-29", downloads: 1 }] }
      : { package: "fixture-package", start: "2026-08-29", end: "2026-08-29", downloads: 2 },
  ), { status: 200 })), /range\/point mismatch/);
});

test("leaves the previous output set untouched when collection fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cg-npm-stats-"));
  try {
    const configPath = join(root, "config.json");
    const names = ["npm-downloads.json", "npm-downloads.svg", "npm-downloads.zh-CN.svg"];
    await writeFile(configPath, JSON.stringify({ schema: 1, title: "fixture", project: "fixture", packages: [
      { package: "fixture-package", label: "fixture", color: "#123abc", start: "2026-08-29" },
    ] }));
    for (const name of names) await writeFile(join(root, name), `previous-${name}`);
    await assert.rejects(
      () => run(["--config", configPath, "--output-dir", root, "--end-date", "2026-08-29"], async () => new Response("unavailable", { status: 503 })),
      /HTTP 503/,
    );
    for (const name of names) assert.equal(await readFile(join(root, name), "utf8"), `previous-${name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
