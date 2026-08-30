import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStatsDocument, renderSvg } from "../scripts/npm-download-stats.mjs";

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
  }
  assert.match(english, /Cumulative downloads/);
  assert.match(chinese, /累计下载量/);
  assert.doesNotMatch(english, /Daily npm downloads/);
  assert.doesNotMatch(chinese, /每日 npm 下载量/);
});

test("rejects a rename date outside the rendered period", () => {
  const document = buildStatsDocument({ ...config, rename: { date: "2026-08-30", label: "bad" } }, collected, "2026-08-30T04:37:00.000Z", "2026-08-29");
  assert.throws(() => renderSvg(document), /rename date is outside/);
});
