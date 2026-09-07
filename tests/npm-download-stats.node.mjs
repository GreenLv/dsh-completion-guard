import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildObservationDocument,
  buildStatsDocument,
  buildTickLayout,
  collectPackageSeries,
  enumerateDays,
  latestCandidateUtcDay,
  normalizeRangePayload,
  reconcilePointPayload,
  renderSvg,
  resolvePackageHistory,
  run,
  settledThrough,
  splitDateRange,
} from "../scripts/npm-download-stats.mjs";

const oldSpec = { package: "dsh-context-guard", label: "dsh-context-guard", color: "#f59e0b", start: "2026-08-26" };
const newSpec = { package: "dsh-completion-guard", label: "dsh-completion-guard", color: "#2563eb", start: "2026-08-29" };
const config = {
  schema: 1,
  title: "rename fixture",
  project: "dsh-completion-guard",
  rename: { date: "2026-08-29", label: "renamed to dsh-completion-guard" },
  packages: [oldSpec, newSpec],
};

function daily(start, end, value = 1) {
  return enumerateDays(start, end).map((day, index) => ({ day, downloads: typeof value === "function" ? value(day, index) : value }));
}

function collected(end, oldValue = 1, newValue = 1) {
  return [
    { spec: oldSpec, downloads: daily(oldSpec.start, end, oldValue), sources: [] },
    { spec: newSpec, downloads: daily(newSpec.start, end, newValue), sources: [] },
  ];
}

function legacyPublished(end, generatedAt = "2026-09-02T04:00:00.000Z") {
  return buildStatsDocument(config, collected(end), generatedAt, end);
}

test("requires explicit daily rows and keeps range and point totals equal", () => {
  const expected = { packageName: oldSpec.package, start: "2026-08-26", end: "2026-08-28" };
  const payload = {
    package: oldSpec.package,
    start: expected.start,
    end: expected.end,
    downloads: [
      { day: "2026-08-28", downloads: 4 },
      { day: "2026-08-26", downloads: 2 },
      { day: "2026-08-27", downloads: 0 },
    ],
  };
  const normalized = normalizeRangePayload(payload, expected);
  assert.deepEqual(normalized.map((item) => item.day), enumerateDays(expected.start, expected.end));
  assert.equal(reconcilePointPayload({ package: oldSpec.package, start: expected.start, end: expected.end, downloads: 6 }, expected, normalized), 6);
  assert.throws(() => normalizeRangePayload({ ...payload, downloads: payload.downloads.slice(1) }, expected), /missing days/);
  assert.throws(() => normalizeRangePayload({ ...payload, downloads: [...payload.downloads, payload.downloads[0]] }, expected), /duplicate range day/);
});

test("uses yesterday only as the candidate observation boundary", () => {
  assert.equal(latestCandidateUtcDay("2026-09-03T04:37:00.000Z"), "2026-09-02");
  assert.equal(latestCandidateUtcDay("2026-09-03T00:30:00+08:00"), "2026-09-01");
  assert.throws(() => latestCandidateUtcDay("not-a-timestamp"), /generatedAt must be an ISO timestamp/);
});

test("settles the dual-package history only after unchanged separated observations", () => {
  const previous = legacyPublished("2026-09-02");
  const unchanged = buildObservationDocument(config, collected("2026-09-02"), "2026-09-03T04:37:00.000Z", "2026-09-02", previous);
  assert.equal(settledThrough(unchanged), "2026-09-01");
  const changed = buildObservationDocument(
    config,
    collected("2026-09-02", 1, (day) => day === "2026-09-01" ? 2 : 1),
    "2026-09-03T04:37:00.000Z",
    "2026-09-02",
    previous,
  );
  assert.equal(settledThrough(changed), "2026-08-31");
});

test("renders a zero-based y axis and aligns every point and marker with its date", () => {
  const document = buildStatsDocument(config, collected("2026-09-02"), "2026-09-03T04:37:00.000Z", "2026-09-02");
  assert.deepEqual(document.project_cumulative.map((item) => item.cumulative), [1, 2, 3, 5, 7, 9, 11, 13]);
  const english = renderSvg(document, "en");
  const chinese = renderSvg(document, "zh-CN");
  for (const svg of [english, chinese]) {
    assert.match(svg, /y1="436"[^>]+class="grid"\/><text[^>]+class="axis">0<\/text>/);
    assert.match(svg, /data-renderer-version="3"/);
    assert.match(svg, /x="84\.00" y="464" text-anchor="middle" class="axis x-axis-tick" data-day="2026-08-26"/);
    assert.match(svg, /x="900\.00" y="464" text-anchor="middle" class="axis x-axis-tick" data-day="2026-09-02"/);
    assert.match(svg, /class="endpoint-badge" data-position="below">/);
    assert.match(svg, /class="endpoint-backdrop"/);
    const endpointY = Number(svg.match(/<circle cx="[^"]+" cy="([^"]+)" r="5" fill="#ffffff" stroke="#0f766e"/)[1]);
    const badge = svg.match(/<g class="endpoint-badge" data-position="(above|below)">\s*<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/);
    const badgeY = Number(badge[2]);
    const badgeHeight = Number(badge[3]);
    assert.ok(badge[1] === "above" ? badgeY + badgeHeight < endpointY : badgeY > endpointY);
    assert.match(svg, /dsh-context-guard/);
    assert.match(svg, /dsh-completion-guard/);
    const labels = [...svg.matchAll(/class="axis x-axis-tick" data-day="([^"]+)">([^<]+)<\/text>/g)];
    assert.equal(labels.length, 8);
    assert.deepEqual(labels.map((match) => match[1]), enumerateDays("2026-08-26", "2026-09-02"));
    const tickXs = [...svg.matchAll(/<text x="([^"]+)" y="464"[^>]+data-day="([^"]+)"/g)];
    const points = svg.match(/<polyline points="([^"]+)"/)[1].split(" ").map((point) => point.split(",").map(Number));
    assert.equal(points.length, tickXs.length);
    assert.ok(points[0][1] < 436, "the first real daily value must not be replaced by a synthetic zero point");
    assert.deepEqual(points.map((point) => point[0]), tickXs.map((match) => Number(match[1])));
    const renameX = Number(svg.match(/<line x1="([^"]+)" y1="176"[^>]+class="rename"/)[1]);
    assert.ok(Math.abs(renameX - Number(tickXs.find((match) => match[2] === "2026-08-29")[1])) < 0.01);
  }
  assert.match(english, /Full daily history · 2026-08-26 → 2026-09-02/);
  assert.match(chinese, /全量每日历史 · 2026-08-26 → 2026-09-02/);
});

test("uses one calendar stride and centered anchors without an irregular final tick", () => {
  for (const [start, end] of [["2026-08-26", "2026-09-02"], ["2026-08-26", "2026-09-06"], ["2026-01-01", "2026-12-31"], ["2025-12-24", "2027-01-12"]]) {
    const days = enumerateDays(start, end);
    const ticks = buildTickLayout(days, 84, 816);
    assert.equal(ticks[0].day, start);
    if (days.length <= 12) assert.equal(ticks.length, days.length);
    for (let index = 0; index < ticks.length; index += 1) {
      assert.equal(ticks[index].anchor, "middle");
      assert.ok(ticks[index].left >= 18 && ticks[index].right <= 942);
      if (index > 0) {
        assert.equal(ticks[index].index - ticks[index - 1].index, ticks[0].stepDays);
        assert.ok(Math.abs(ticks[index].x - ticks[index - 1].x - 816 * ticks[0].stepDays / (days.length - 1)) < 1e-8);
        assert.ok(ticks[index].left - ticks[index - 1].right >= 17.9);
      }
    }
    const doc = buildStatsDocument({ ...config, rename: null, packages: [{ ...oldSpec, start }] }, [{ spec: { ...oldSpec, start }, downloads: daily(start, end), sources: [] }], "2027-02-01T00:00:00Z", end);
    assert.ok(renderSvg(doc).includes(`${start} → ${end}`), "coverage caption retains exact final day even when not a tick");
  }
});

test("rejects missing collected dates and splits long ranges without gaps", () => {
  const source = collected("2026-09-02");
  source[0].downloads.splice(1, 1);
  assert.throws(() => buildStatsDocument(config, source, "2026-09-03T04:37:00.000Z", "2026-09-02"), /collected series missing/);
  assert.deepEqual(splitDateRange("2024-01-01", "2024-12-31", 365), [
    { start: "2024-01-01", end: "2024-12-30" },
    { start: "2024-12-31", end: "2024-12-31" },
  ]);
});

test("preserves prior chart bytes while revised observations settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cg-npm-stats-"));
  try {
    const previousDir = join(root, "previous");
    const outputDir = join(root, "output");
    await mkdir(previousDir);
    const previous = legacyPublished("2026-08-31", "2026-09-02T03:00:00.000Z");
    previous.renderer_version = 2;
    await writeFile(join(root, "config.json"), JSON.stringify(config));
    await writeFile(join(previousDir, "npm-downloads.json"), JSON.stringify(previous));
    await writeFile(join(previousDir, "npm-downloads.svg"), "previous-en");
    await writeFile(join(previousDir, "npm-downloads.zh-CN.svg"), "previous-zh");
    const fetchImpl = async (url) => {
      const packageNameFromUrl = decodeURIComponent(url.split("/").at(-1));
      const spec = packageNameFromUrl === oldSpec.package ? oldSpec : newSpec;
      if (url.startsWith("https://registry.npmjs.org/")) return new Response(JSON.stringify({ name: spec.package, time: { "0.1.0": `${spec.start}T12:00:00Z` } }));
      if (url.includes("/point/last-day/")) return new Response(JSON.stringify({ package: spec.package, start: "2026-09-02", end: "2026-09-02", downloads: 2 }));
      const match = url.match(/\/(range|point)\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\/([^/]+)$/);
      const [, kind, start, end, encodedPackage] = match;
      const packageName = decodeURIComponent(encodedPackage);
      const rows = daily(start, end, 2);
      const payload = kind === "range"
        ? { package: packageName, start, end, downloads: rows }
        : { package: packageName, start, end, downloads: rows.reduce((sum, item) => sum + item.downloads, 0) };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const result = await run([
      "--config", join(root, "config.json"),
      "--output-dir", outputDir,
      "--previous-dir", previousDir,
      "--generated-at", "2026-09-03T04:37:00.000Z",
    ], fetchImpl);
    assert.equal(result.publish_mode, "preserved");
    assert.equal(result.data_through, "2026-08-31");
    assert.equal(await readFile(join(outputDir, "npm-downloads.svg"), "utf8"), "previous-en");
    assert.equal(await readFile(join(outputDir, "npm-downloads.zh-CN.svg"), "utf8"), "previous-zh");
    const observation = JSON.parse(await readFile(join(outputDir, "observations.json"), "utf8"));
    assert.equal(observation.candidate_through, "2026-09-02");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on an npm API request failure", async () => {
  await assert.rejects(collectPackageSeries(oldSpec, "2026-08-26", async () => ({ ok: false, status: 503 })), /HTTP 503/);
});


test("checks registry first-public dates and treats last-day only as availability", async () => {
  const mock = (first, end) => async (url) => new Response(JSON.stringify(url.includes("registry.npmjs.org")
    ? { name: oldSpec.package, time: { created: "2020-01-01T00:00:00Z", "0.2.0": "2026-08-27T12:00:00Z", "0.1.0": first } }
    : { package: oldSpec.package, start: end, end, downloads: 0 }));
  const history = await resolvePackageHistory(oldSpec, "2026-09-07T13:00:00Z", mock("2026-08-26T19:24:20Z", "2026-09-05"));
  assert.equal(history.first_public_day, "2026-08-26");
  assert.equal(history.first_version, "0.1.0");
  assert.equal(history.available_through, "2026-09-05");
  assert.equal((await resolvePackageHistory(oldSpec, "2026-09-07T13:00:00Z", mock("2026-08-26T19:24:20Z", "2026-09-07"))).available_through, "2026-09-06");
  await assert.rejects(resolvePackageHistory(oldSpec, "2026-09-07T13:00:00Z", mock("2026-08-25T19:24:20Z", "2026-09-06")), /first public day differs/);
});

test("small totals keep distinct integer y ticks and preserve a nonzero first day", () => {
  for (const value of [0, 1, 2, 95]) {
    const single = { ...config, rename: null, packages: [oldSpec] };
    const doc = buildStatsDocument(single, [{ spec: oldSpec, downloads: [{ day: oldSpec.start, downloads: value }], sources: [] }], "2026-08-29T00:00:00Z", oldSpec.start);
    const svg = renderSvg(doc);
    const labels = [...svg.matchAll(/text-anchor="end" class="axis">([^<]+)<\/text>/g)].map((m) => Number(m[1]));
    assert.equal(labels[0], 0);
    assert.equal(new Set(labels).size, labels.length);
    const pointY = Number(svg.match(/<polyline points="[0-9.]+,([0-9.]+)"/)[1]);
    assert.equal(pointY === 436, value === 0);
    assert.equal(doc.project_cumulative[0].cumulative, value);
  }
});
