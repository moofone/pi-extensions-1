import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectUsageData, collectUsageDataLegacy, emptyHourlyCell, loadUsageCache, makeHourlyKey } from "../usage-extension/data.ts";
import { splitCost } from "../usage-extension/sources.ts";
import {
	PAINT_MARK,
	STACK_OTHER_KEY,
	buildUsageStack,
	planBuckets,
	renderStackedBars,
	stackStats,
	sumMetricInRange,
} from "../usage-extension/bars.ts";
import {
	OVERALL_HIT_KEY,
	buildCacheModel,
	buildCacheStack,
	buildInputRates,
	hitPercent,
	missCount,
	netSavings,
	readSavings,
	writePremium,
} from "../usage-extension/cache.ts";
import { buildCacheCsv, buildStackCsv } from "../usage-extension/export.ts";
import { renderChart } from "../usage-extension/graph.ts";

const HOUR = 3_600_000;

// 2026-07-15 (Wednesday) 12:00 local.
const NOW = new Date(2026, 6, 15, 12, 0, 0);
const TODAY = new Date(2026, 6, 15, 0, 0, 0).getTime();
const BOUNDS = {
	todayMs: TODAY,
	weekStartMs: new Date(2026, 6, 13).getTime(),
	lastWeekStartMs: new Date(2026, 6, 6).getTime(),
	last30DaysStartMs: new Date(2026, 5, 16).getTime(),
	nowMs: NOW.getTime(),
};

function dayAt(daysAgo, hour = 10) {
	const d = new Date(TODAY);
	d.setDate(d.getDate() - daysAgo);
	d.setHours(hour);
	return d.getTime();
}

function cell(values = {}) {
	return { ...emptyHourlyCell(), messages: 1, ...values, estCost: values.estCost ?? values.cost ?? 0 };
}

function hourlyOf(entries) {
	const hourly = new Map();
	for (const [ts, provider, model, values] of entries) {
		const hour = Math.floor(ts / HOUR) * HOUR;
		let bucket = hourly.get(hour);
		if (!bucket) hourly.set(hour, (bucket = new Map()));
		bucket.set(makeHourlyKey(provider, model, ""), cell(values));
	}
	return hourly;
}

// =============================================================================
// Bucket planning
// =============================================================================

test("planBuckets: today is 24 hourly buckets, last 30 days is 30 local days", () => {
	const today = planBuckets("today", BOUNDS, new Map(), 200);
	assert.equal(today.unit, "hour");
	assert.equal(today.buckets.length, 24);
	assert.equal(today.nowIdx, 12);

	const month = planBuckets("last30Days", BOUNDS, new Map(), 200);
	assert.equal(month.unit, "day");
	assert.equal(month.buckets.length, 30);
	assert.equal(month.buckets[0].startMs, BOUNDS.last30DaysStartMs);
	assert.equal(month.nowIdx, 29);

	const week = planBuckets("thisWeek", BOUNDS, new Map(), 200);
	assert.equal(week.buckets.length, 7, "full calendar week, future days empty");
	assert.equal(week.nowIdx, 2);
});

test("planBuckets coarsens all-time history to weeks, then months, when columns run out", () => {
	const hourly = hourlyOf([[dayAt(200), "anthropic", "m", { cost: 1 }]]);
	const daily = planBuckets("allTime", BOUNDS, hourly, 500);
	assert.equal(daily.unit, "day");
	assert.equal(daily.buckets.length, 201);
	const weekly = planBuckets("allTime", BOUNDS, hourly, 60);
	assert.equal(weekly.unit, "week");
	assert.ok(weekly.buckets.length <= 60);
	assert.equal(new Date(weekly.buckets[0].startMs).getDay(), 1, "weeks start on Monday");
	const monthly = planBuckets("allTime", BOUNDS, hourly, 10);
	assert.equal(monthly.unit, "month");
	assert.equal(new Date(monthly.buckets[0].startMs).getDate(), 1);
});

// =============================================================================
// Stack model
// =============================================================================

test("buildUsageStack keeps the top N providers (largest at the bottom) and merges the rest into other", () => {
	const hourly = hourlyOf([
		[dayAt(0), "anthropic", "opus", { cost: 50 }],
		[dayAt(0, 11), "openai-codex", "luna", { cost: 20 }],
		[dayAt(1), "xai", "grok", { cost: 10 }],
		[dayAt(1, 11), "devin", "swe", { cost: 5 }],
		[dayAt(2), "zai", "glm", { cost: 3 }],
	]);
	const plan = planBuckets("last30Days", BOUNDS, hourly, 200);
	const model = buildUsageStack(hourly, plan, "cost", "provider", 3);
	assert.deepEqual(
		model.series.map((s) => s.key),
		["anthropic", "openai-codex", "xai", STACK_OTHER_KEY]
	);
	assert.equal(model.series[3].label, "other (2)");
	assert.equal(model.series[3].total, 8);
	assert.equal(model.grandTotal, 88);
	assert.deepEqual(model.values[29], [50, 20, 0, 0]);
	assert.equal(model.totals[28], 15);
	assert.equal(model.yMax, 70);
});

test("buildUsageStack tokens metric uses fresh tokens (input + output + cache write)", () => {
	const hourly = hourlyOf([[dayAt(0), "anthropic", "opus", { input: 10, output: 5, cacheWrite: 100, cacheRead: 9999 }]]);
	const plan = planBuckets("today", BOUNDS, hourly, 200);
	const model = buildUsageStack(hourly, plan, "tokens", "provider", 5);
	assert.equal(model.grandTotal, 115);
});

test("stackStats reports best bucket, active count, and streaks that survive an idle today", () => {
	const hourly = hourlyOf([
		[dayAt(5), "a", "m", { cost: 1 }],
		[dayAt(3), "a", "m", { cost: 9 }],
		[dayAt(2), "a", "m", { cost: 2 }],
		[dayAt(1), "a", "m", { cost: 2 }],
	]);
	const plan = planBuckets("last30Days", BOUNDS, hourly, 200);
	const stats = stackStats(buildUsageStack(hourly, plan, "cost", "provider", 5), 7);
	assert.equal(stats.total, 14);
	assert.equal(stats.activeBuckets, 4);
	assert.equal(stats.bestValue, 9);
	assert.equal(stats.bestIdx, 26);
	assert.equal(stats.currentStreak, 3, "today idle; yesterday back 3 days");
	assert.equal(stats.longestStreak, 3);
	assert.equal(stats.previousTotal, 7);
});

test("sumMetricInRange sums a metric over a half-open window", () => {
	const hourly = hourlyOf([
		[dayAt(1), "a", "m", { cost: 2 }],
		[dayAt(0), "a", "m", { cost: 3 }],
	]);
	assert.equal(sumMetricInRange(hourly, dayAt(1, 0), TODAY, "cost"), 2);
	assert.equal(sumMetricInRange(hourly, dayAt(1, 0), BOUNDS.nowMs, "cost"), 5);
});

// =============================================================================
// Stacked renderer
// =============================================================================

test("renderStackedBars splits a cell between two segments with fg/bg at 1/8 resolution", () => {
	const hourly = hourlyOf([
		[dayAt(0, 9), "a", "m", { cost: 3 }],
		[dayAt(0, 10), "b", "m", { cost: 1 }],
	]);
	const plan = planBuckets("today", BOUNDS, hourly, 200);
	// One bucket would be simpler, but hourly buckets keep both segments in
	// separate bars; use a single-day "lastWeek"-like plan via provider grouping instead.
	const dayPlan = { unit: "day", buckets: [{ startMs: TODAY, endMs: TODAY + 24 * HOUR }], nowIdx: 0 };
	const model = buildUsageStack(hourly, dayPlan, "cost", "provider", 5);
	assert.equal(plan.buckets.length, 24);
	const paint = (fg, bg, text) => `<${fg}/${bg}:${text}>`;
	const lines = renderStackedBars(model, {
		width: 20,
		height: 2,
		formatValue: (v) => String(v),
		formatBucket: () => "d",
		selectedIdx: 0,
		paint,
		maxBarWidth: 1,
	});
	assert.equal(lines.length, 4, "2 plot rows + axis + labels");
	// 16 eighth-units total; a = 12 units (rows 0 full, row 1 half), b = top 4 units.
	assert.match(lines[1], /<0\/-1:█>/, "bottom row fully segment a");
	assert.match(lines[0], /<0\/1:▄>/, "top row: lower half a (fg), upper half b (bg)");
	assert.ok(lines[2].includes(`<${PAINT_MARK}/-1:▲>`), "selected bucket is marked on the axis");
});

test("renderStackedBars noBackground mode never emits a background and picks the dominant segment", () => {
	const hourly = hourlyOf([
		[dayAt(0, 9), "a", "m", { cost: 3 }],
		[dayAt(0, 10), "b", "m", { cost: 1 }],
	]);
	const dayPlan = { unit: "day", buckets: [{ startMs: TODAY, endMs: TODAY + 24 * HOUR }], nowIdx: 0 };
	const model = buildUsageStack(hourly, dayPlan, "cost", "provider", 5);
	const paint = (fg, bg, text) => `<${fg}/${bg}:${text}>`;
	const lines = renderStackedBars(model, { width: 20, height: 2, formatValue: String, formatBucket: () => "d", paint, maxBarWidth: 1, noBackground: true });
	for (const l of lines) assert.ok(!/<-?\d+\/[0-9]+:/.test(l), `no series background in: ${l}`);
	// Top row: a has 4 eighths, b has 4 → tie keeps the lower segment; full height.
	assert.match(lines[0], /<0\/-1:█>/);
	// a = 10 of 16 eighths, b = 6: the top row holds 2 of a and 6 of b, so b wins.
	const skew = buildUsageStack(hourlyOf([[dayAt(0, 9), "a", "m", { cost: 2.5 }], [dayAt(0, 10), "b", "m", { cost: 1.5 }]]), dayPlan, "cost", "provider", 5);
	const skewLines = renderStackedBars(skew, { width: 20, height: 2, formatValue: String, formatBucket: () => "d", paint, maxBarWidth: 1, noBackground: true });
	assert.match(skewLines[0], /<1\/-1:█>/, "b covers 6 of the top row's 8 eighths");
});

test("renderStackedBars gives any non-empty bucket at least a sliver", () => {
	const hourly = hourlyOf([
		[dayAt(1), "a", "m", { cost: 1000 }],
		[dayAt(0), "a", "m", { cost: 0.001 }],
	]);
	const plan = planBuckets("lastWeek", { ...BOUNDS, lastWeekStartMs: dayAt(1, 0), weekStartMs: TODAY + 24 * HOUR }, hourly, 200);
	const model = buildUsageStack(hourly, plan, "cost", "provider", 5);
	const lines = renderStackedBars(model, { width: 30, height: 4, formatValue: String, formatBucket: () => "x" });
	assert.ok(lines[3].includes("▁"), "tiny day still visible on the bottom row");
});

// =============================================================================
// Cost split + data capture
// =============================================================================

test("splitCost prefers a recorded breakdown, rescales it to the target total, and falls back to catalog rates", () => {
	const amount = { cost: 1, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	const recorded = splitCost("anthropic", "claude-opus-5", amount, 2, { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(recorded, { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0, unsplit: 0 });
	// Opus catalog: $5 in / $25 out per M → 1:5 split of $3.
	const catalog = splitCost("anthropic", "claude-opus-5", amount, 3);
	assert.ok(Math.abs(catalog.input - 0.5) < 1e-9 && Math.abs(catalog.output - 2.5) < 1e-9);
	const unknown = splitCost("nobody", "mystery", amount, 4);
	assert.equal(unknown.unsplit, 4);
	assert.deepEqual(splitCost("nobody", "mystery", amount, 0), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unsplit: 0 });
});

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "usage-dash-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	return { root, sessionsDir, cachePath: join(root, "cache.json") };
}

function line(ts, { provider = "anthropic", model = "claude-opus-5", input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h, cost }) {
	const usage = { input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}), cost };
	return JSON.stringify({
		type: "message",
		id: `m${ts}`,
		timestamp: new Date(ts).toISOString(),
		message: { role: "assistant", provider, model, usage, timestamp: ts, content: [] },
	});
}

test("collectUsageData captures the per-class cost split, 1h writes, and cache-miss causes into hourly cells", async (t) => {
	const { sessionsDir, cachePath } = fixture(t);
	const T = new Date(2026, 6, 15, 9, 0, 0).getTime();
	writeFileSync(
		join(sessionsDir, "a.jsonl"),
		[
			JSON.stringify({ type: "session", id: "s1", timestamp: new Date(T).toISOString(), cwd: "/w" }),
			line(T, {
				input: 10,
				output: 100,
				cacheRead: 50_000,
				cacheWrite: 1000,
				cacheWrite1h: 1000,
				cost: { input: 0.01, output: 0.2, cacheRead: 0.05, cacheWrite: 0.04, total: 0.3 },
			}),
			// 10 minutes idle and no cache read → TTL miss.
			line(T + 10 * 60_000, { input: 51_000, output: 10, cost: { input: 0.5, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.51 } }),
			// A provider that never reports cache tokens: no miss classification.
			line(T + 11 * 60_000, { provider: "cursor", model: "auto", input: 80_000, cost: { total: 0.2 } }),
			line(T + 11 * 60_000 + 1000, { provider: "cursor", model: "auto", input: 80_000, cost: { total: 0.2 } }),
		].join("\n") + "\n"
	);
	const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
	const hour = Math.floor(T / HOUR) * HOUR;
	const opus = data.hourly.get(hour).get(makeHourlyKey("anthropic", "claude-opus-5", ""));
	assert.equal(opus.cacheWrite1h, 1000);
	assert.ok(Math.abs(opus.costCacheRead - 0.05) < 1e-12);
	assert.ok(Math.abs(opus.costInput - 0.51) < 1e-12);
	assert.equal(opus.missTtl, 1);
	assert.ok(Math.abs(opus.missTtlCost - 0.51) < 1e-12);
	const cursor = data.hourly.get(hour).get(makeHourlyKey("cursor", "auto", ""));
	assert.equal(cursor.missPrefix + cursor.missTtl + cursor.missSwitch, 0, "non-reporting provider never counts misses");
	assert.equal(cursor.costUnsplit, 0.4, "no breakdown and no catalog rate → unattributed");

	// Round-trip through the legacy v7 cache keeps the split (the index store has its own format).
	await collectUsageDataLegacy({ sessionsDir, cachePath, now: NOW });
	const reloaded = await loadUsageCache(cachePath);
	const msgs = reloaded.get(join(sessionsDir, "a.jsonl")).parsed.messages;
	assert.equal(msgs[0].costCacheWrite, 0.04);
	assert.equal(msgs[0].cacheWrite1h, 1000);
	assert.equal(msgs[2].costInput, 0, "short tuple loads with zero extras");
});

test("loadUsageCache accepts both base and extended v7 message tuples", async (t) => {
	const { root } = fixture(t);
	const cachePath = join(root, "v7.json");
	writeFileSync(
		cachePath,
		JSON.stringify({
			version: 7,
			names: ["p", "m", "", ""],
			files: {
				"/short.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", cwd: "/w", messages: [[0, 1, 1, 1, 1, 0, 0, 5, 2, 0, 0, 0, 3]], toolUsages: [] },
				"/long.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", cwd: "/w", messages: [[0, 1, 1, 1, 1, 0, 0, 5, 2, 0, 0, 0, 3, 0.1, 0.2, 0.3, 0.4, 7]], toolUsages: [] },
				"/odd.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", cwd: "/w", messages: [[0, 1, 1, 1, 1, 0, 0, 5, 2, 0, 0, 0, 3, 0.1]], toolUsages: [] },
			},
		})
	);
	const loaded = await loadUsageCache(cachePath);
	assert.deepEqual([...loaded.keys()].sort(), ["/long.jsonl", "/short.jsonl"]);
	assert.equal(loaded.get("/long.jsonl").parsed.messages[0].cacheWrite1h, 7);
	assert.equal(loaded.get("/long.jsonl").parsed.messages[0].costCacheWrite, 0.4);
});

// =============================================================================
// Cache analytics
// =============================================================================

test("buildInputRates prefers observed input $/token and records which providers report cache", () => {
	const hourly = hourlyOf([
		[dayAt(0), "anthropic", "claude-opus-5", { input: 1000, costInput: 0.01, cacheRead: 5 }],
		[dayAt(0, 11), "anthropic", "claude-sonnet-5", { cacheRead: 100 }],
		[dayAt(0, 12), "cursor", "auto", { input: 500 }],
	]);
	const ctx = buildInputRates(hourly);
	assert.equal(ctx.rates.get("anthropic\u0000claude-opus-5"), 0.00001);
	assert.equal(ctx.rates.get("anthropic\u0000claude-sonnet-5"), 2 / 1_000_000, "catalog fallback");
	assert.equal(ctx.rates.get("cursor\u0000auto"), 0);
	assert.ok(ctx.reporting.has("anthropic"));
	assert.ok(!ctx.reporting.has("cursor"));
});

test("buildCacheModel computes hit%, savings vs input price, write premium, and excludes non-reporting providers", () => {
	// Rate: $10 per M input → 1e-5 $/token.
	const hourly = hourlyOf([
		[
			dayAt(0),
			"anthropic",
			"opus",
			{
				input: 100,
				costInput: 0.001,
				cacheRead: 900_000,
				costCacheRead: 0.9,
				cacheWrite: 1000,
				cacheWrite1h: 400,
				costCacheWrite: 0.02,
				estCost: 0.921,
				missTtl: 2,
				missTtlCost: 0.5,
			},
		],
		[dayAt(1), "cursor", "auto", { input: 1_000_000, estCost: 1 }],
	]);
	const ctx = buildInputRates(hourly);
	const plan = planBuckets("last30Days", BOUNDS, hourly, 200);
	const model = buildCacheModel(hourly, plan, ctx);
	const t = model.totals;
	assert.equal(t.cacheRead, 900_000);
	assert.equal(t.input, 100, "cursor input excluded from hit math");
	assert.equal(t.unreportedPrompt, 1_000_000);
	assert.ok(Math.abs(hitPercent(t) - (900_000 / 901_100) * 100) < 1e-9);
	assert.ok(Math.abs(readSavings(t) - (900_000 * 1e-5 - 0.9)) < 1e-9); // $8.10
	assert.ok(Math.abs(writePremium(t) - (0.02 - 1000 * 1e-5)) < 1e-9); // $0.01
	assert.ok(Math.abs(netSavings(t) - 8.09) < 1e-9);
	assert.equal(missCount(t), 2);
	assert.equal(t.estCost, 1.921, "spend still includes non-reporting providers");

	assert.equal(model.rows[0].key, "cursor", "rows sorted by spend");
	assert.equal(model.hitSeries[0].key, OVERALL_HIT_KEY);
	assert.deepEqual(
		model.hitSeries.map((s) => s.key),
		[OVERALL_HIT_KEY, "anthropic"],
		"only rows with cache reads get a hit line"
	);
	assert.ok(Number.isNaN(model.hitSeries[1].points[0]), "no prompt that day → gap");
	assert.ok(model.hitSeries[1].points[29] > 99);
});

test("buildCacheStack composes cost by token class and drops non-reporting prompt tokens", () => {
	const hourly = hourlyOf([
		[dayAt(0), "anthropic", "opus", { input: 10, cacheRead: 90, costCacheRead: 1, costCacheWrite: 2, costInput: 3, costOutput: 4, costUnsplit: 5 }],
		[dayAt(0, 11), "cursor", "auto", { input: 1000 }],
	]);
	const ctx = buildInputRates(hourly);
	const plan = planBuckets("last30Days", BOUNDS, hourly, 200);
	const cost = buildCacheStack(hourly, plan, "cost", ctx);
	assert.deepEqual(cost.values[29], [1, 2, 3, 4, 5]);
	const tokens = buildCacheStack(hourly, plan, "tokens", ctx);
	assert.deepEqual(tokens.values[29], [90, 0, 10]);
});

test("cache and stack CSV exports have one row per bucket plus totals", () => {
	const hourly = hourlyOf([[dayAt(0), "anthropic", "opus", { input: 10, cacheRead: 90, cost: 1 }]]);
	const plan = planBuckets("thisWeek", BOUNDS, hourly, 200);
	const stackCsv = buildStackCsv(buildUsageStack(hourly, plan, "cost", "provider", 5));
	assert.equal(stackCsv.trim().split("\n").length, 1 + 7);
	assert.match(stackCsv.split("\n")[0], /^bucket_start,bucket_end,anthropic,total$/);
	const model = buildCacheModel(hourly, plan, buildInputRates(hourly));
	const cacheCsv = buildCacheCsv(model, plan.buckets.map((b) => b.startMs)).trim().split("\n");
	assert.equal(cacheCsv.length, 1 + 7 + 1 + 1);
	assert.match(cacheCsv[cacheCsv.length - 1], /^TOTAL,,90,/);
});

// =============================================================================
// Line chart: y floor + gaps
// =============================================================================

test("renderChart honours yMin and breaks lines at NaN gaps", () => {
	const model = {
		series: [{ key: "s", label: "s", points: [90, Number.NaN, 100], total: 1, hidden: false, firstIdx: 0, lastIdx: 2 }],
		bucketStarts: [0, 1, 2],
		bucketMs: 1,
		domainStartMs: 0,
		domainEndMs: 2,
		yMax: 100,
		yMin: 90,
		groupedTotal: 0,
	};
	const lines = renderChart(model, { width: 16, height: 4, formatValue: (v) => `${Math.round(v)}%`, formatTime: String });
	assert.match(lines[0], /^100% ┤/);
	assert.match(lines[3], /^ 90% ┤/);
	// 90 sits on the bottom row at the far left; 100 on the top row at the far right.
	assert.notEqual(lines[3].slice(6, 7).trim(), "");
	assert.notEqual(lines[0].trimEnd().slice(-1), "┤");
	// No connecting segment across the gap: middle rows stay empty.
	assert.equal(lines[1].slice(6).trim(), "");
	assert.equal(lines[2].slice(6).trim(), "");
});
