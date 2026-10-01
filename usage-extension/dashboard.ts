/**
 * Daily (stacked bars) and Cache views for /usage.
 *
 * Rendering only: models come from bars.ts / cache.ts and are memoized by the
 * caller, so a keypress re-renders from cached models instead of re-scanning.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { PeriodBounds, TabName, UsageData } from "./data.ts";
import { AUXILIARY_PROVIDER } from "./data.ts";
import type { Bucket, BucketPlan, BucketUnit, StackGroupBy, StackMetric, StackModel } from "./bars.ts";
import {
	PAINT_AXIS,
	PAINT_LABEL,
	PAINT_MARK,
	PAINT_NONE,
	STACK_OTHER_KEY,
	buildUsageStack,
	planBuckets,
	renderStackedBars,
	stackLayout,
	stackPlotCapacity,
	stackStats,
	sumMetricInRange,
} from "./bars.ts";
import type { CacheChart, CacheGroupBy, CacheModel, CacheTotals, InputRates } from "./cache.ts";
import {
	CACHE_CHART_LABELS,
	OVERALL_HIT_KEY,
	buildCacheModel,
	buildCacheStack,
	hitPercent,
	missCost,
	missCount,
	netSavings,
	promptTokens,
	readSavings,
	writePremium,
} from "./cache.ts";
import type { GraphModel } from "./graph.ts";
import { renderChart } from "./graph.ts";

export type Memo = <T>(key: string, build: () => T) => T;

// =============================================================================
// Colours (256-colour, stable per series name)
// =============================================================================

const KNOWN_COLORS: Record<string, number> = {
	anthropic: 208, // orange
	"openai-codex": 36, // teal
	openai: 36,
	xai: 75, // sky
	devin: 141, // lavender
	"opencode-go": 220, // yellow
	zai: 39, // blue
	cursor: 252,
	antigravity: 33,
	google: 33,
	workbuddy: 170,
	[AUXILIARY_PROVIDER]: 245,
};
const PALETTE = [170, 44, 214, 105, 150, 203, 117, 186, 79, 213, 110, 180];
const OTHER_COLOR = 240;
const OVERALL_COLOR = 255;

function hashName(name: string): number {
	let h = 2166136261;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Stable colour per key; collisions inside one view walk the palette. */
export function assignSeriesColors(keys: string[]): number[] {
	const used = new Set<number>();
	return keys.map((key) => {
		let color: number;
		if (key === STACK_OTHER_KEY) color = OTHER_COLOR;
		else if (key === OVERALL_HIT_KEY) color = OVERALL_COLOR;
		else color = KNOWN_COLORS[key] ?? PALETTE[hashName(key) % PALETTE.length]!;
		if (used.has(color) && key !== STACK_OTHER_KEY) {
			const start = PALETTE.indexOf(color);
			for (let i = 1; i <= PALETTE.length; i++) {
				const candidate = PALETTE[(Math.max(start, 0) + i) % PALETTE.length]!;
				if (!used.has(candidate)) {
					color = candidate;
					break;
				}
			}
		}
		used.add(color);
		return color;
	});
}

const CACHE_CHART_COLORS: Record<CacheChart, number[]> = {
	// cache read, cache write, uncached input, output, unattributed
	cost: [78, 214, 203, 75, 244],
	tokens: [78, 214, 203],
	// ttl, model switch, prefix
	misses: [214, 141, 203],
};

const fgCode = (c: number) => `\x1b[38;5;${c}m`;
const bgCode = (c: number) => `\x1b[48;5;${c}m`;
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

function swatch(color: number, ch = "●"): string {
	return fgCode(color) + ch + FG_RESET;
}

function stackPainter(th: Theme, colors: number[]) {
	return (fg: number, bg: number, text: string): string => {
		if (fg === PAINT_AXIS || fg === PAINT_LABEL) return th.fg("dim", text);
		if (fg === PAINT_MARK) return th.fg("accent", th.bold(text));
		if (fg === PAINT_NONE && bg === PAINT_NONE) return text;
		const f = fg >= 0 ? fgCode(colors[fg] ?? OTHER_COLOR) : "";
		const b = bg >= 0 ? bgCode(colors[bg] ?? OTHER_COLOR) : "";
		return f + b + text + (f ? FG_RESET : "") + (b ? BG_RESET : "");
	};
}

// =============================================================================
// Formatting
// =============================================================================

export function formatMoney(v: number): string {
	const a = Math.abs(v);
	const sign = v < 0 ? "-" : "";
	if (a === 0) return "$0";
	if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
	if (a >= 100) return `${sign}$${a.toFixed(0)}`;
	if (a >= 0.01) return `${sign}$${a.toFixed(2)}`;
	return `${sign}$${a.toFixed(4)}`;
}

export function formatMoneyShort(v: number): string {
	const a = Math.abs(v);
	const sign = v < 0 ? "-" : "";
	if (a === 0) return "$0";
	if (a < 10) return `${sign}$${a.toFixed(2)}`;
	if (a < 1000) return `${sign}$${Math.round(a)}`;
	if (a < 1_000_000) return `${sign}$${(a / 1000).toFixed(a < 10_000 ? 1 : 0)}k`;
	return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
}

export function formatCount(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return "0";
	if (a < 1000) return String(Math.round(v));
	if (a < 1_000_000) return `${(v / 1000).toFixed(a < 10_000 ? 1 : 0)}k`;
	if (a < 1_000_000_000) return `${(v / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0)}M`;
	return `${(v / 1_000_000_000).toFixed(a < 10_000_000_000 ? 2 : 1)}B`;
}

function formatPct(v: number, digits = 1): string {
	return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "–";
}

function metricFormatter(metric: StackMetric, short: boolean): (v: number) => string {
	if (metric === "cost") return short ? formatMoneyShort : formatMoney;
	return formatCount;
}

const SHARE_GLYPHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Horizontal bar of `frac` (0..1) over `width` cells at 1/8 resolution. */
export function shareBar(frac: number, width: number): string {
	const units = Math.round(Math.max(0, Math.min(1, frac)) * width * 8);
	const full = Math.floor(units / 8);
	const rest = units % 8;
	return "█".repeat(full) + (rest > 0 ? SHARE_GLYPHS[rest] : "");
}

function padL(s: string, n: number): string {
	const w = visibleWidth(s);
	return w >= n ? s : " ".repeat(n - w) + s;
}

function padR(s: string, n: number): string {
	const w = visibleWidth(s);
	return w >= n ? s : s + " ".repeat(n - w);
}

function fit(s: string, n: number, align: "left" | "right" = "left"): string {
	if (n <= 0) return "";
	const t = truncateToWidth(s, n);
	return align === "right" ? padL(t, n) : padR(t, n);
}

/** Join segments with a separator, wrapping onto new lines as width allows. */
function flow(segments: string[], width: number, sep: string, indent = ""): string[] {
	const lines: string[] = [];
	let current = indent;
	let empty = true;
	for (const seg of segments) {
		const candidate = empty ? current + seg : current + sep + seg;
		if (!empty && visibleWidth(candidate) > width) {
			lines.push(current);
			current = indent + seg;
		} else {
			current = candidate;
		}
		empty = false;
	}
	if (!empty) lines.push(current);
	return lines;
}

function bucketAxisLabel(startMs: number, unit: BucketUnit): string {
	const d = new Date(startMs);
	switch (unit) {
		case "hour":
			return `${String(d.getHours()).padStart(2, "0")}:00`;
		case "day":
		case "week":
			return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
		case "month":
			return `${d.toLocaleDateString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
	}
}

export function bucketTitle(b: Bucket, unit: BucketUnit): string {
	const d = new Date(b.startMs);
	switch (unit) {
		case "hour": {
			const h = d.getHours();
			return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
		}
		case "day":
			return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
		case "week":
			return `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
		case "month":
			return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
	}
}

const UNIT_ADJECTIVE: Record<BucketUnit, string> = { hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly" };
const UNIT_NOUN: Record<BucketUnit, string> = { hour: "hour", day: "day", week: "week", month: "month" };

/** Window for "vs previous": same elapsed span immediately before the period. */
export function previousWindow(period: TabName, bounds: PeriodBounds): { startMs: number; endMs: number; label: string } | null {
	const DAY = 86_400_000;
	switch (period) {
		case "today":
			return { startMs: bounds.todayMs - DAY, endMs: bounds.nowMs - DAY, label: "yesterday so far" };
		case "thisWeek":
			return { startMs: bounds.lastWeekStartMs, endMs: bounds.nowMs - 7 * DAY, label: "last week so far" };
		case "lastWeek":
			return { startMs: bounds.lastWeekStartMs - 7 * DAY, endMs: bounds.lastWeekStartMs, label: "the week before" };
		case "last30Days":
			return { startMs: bounds.last30DaysStartMs - 30 * DAY, endMs: bounds.nowMs - 30 * DAY, label: "prior 30 days" };
		case "allTime":
			return null;
	}
}

// =============================================================================
// Shared plan helper
// =============================================================================

/** Chart width used by both views; bars look odd beyond ~150 columns. */
export function chartWidth(width: number): number {
	return Math.max(Math.min(width, 150), 30);
}

export function planFor(memo: Memo, data: UsageData, period: TabName, width: number): BucketPlan {
	const capacity = stackPlotCapacity(chartWidth(width));
	return memo(`plan|${period}|${capacity}`, () => planBuckets(period, data.bounds, data.hourly, capacity));
}

export function resolveCursor(plan: BucketPlan, cursor: number | null): number {
	if (plan.buckets.length === 0) return -1;
	if (cursor === null) return plan.nowIdx >= 0 ? plan.nowIdx : plan.buckets.length - 1;
	return Math.max(0, Math.min(plan.buckets.length - 1, cursor));
}

// =============================================================================
// Daily view
// =============================================================================

export interface DailyViewState {
	period: TabName;
	metric: StackMetric;
	groupBy: StackGroupBy;
	topN: number;
	cursor: number | null;
}

export function dailyStackFor(memo: Memo, data: UsageData, state: DailyViewState, width: number): StackModel {
	const plan = planFor(memo, data, state.period, width);
	const capacity = stackPlotCapacity(chartWidth(width));
	return memo(`stack|${state.period}|${capacity}|${state.metric}|${state.groupBy}|${state.topN}`, () =>
		buildUsageStack(data.hourly, plan, state.metric, state.groupBy, state.topN)
	);
}

export function renderDailyView(th: Theme, data: UsageData, state: DailyViewState, width: number, maxLines: number, memo: Memo): string[] {
	const plan = planFor(memo, data, state.period, width);
	const model = dailyStackFor(memo, data, state, width);
	const fmt = metricFormatter(state.metric, false);
	const fmtShort = metricFormatter(state.metric, true);
	const lines: string[] = [];

	const prev = previousWindow(state.period, data.bounds);
	const prevTotal = prev
		? memo(`prev|${state.period}|${state.metric}`, () => sumMetricInRange(data.hourly, prev.startMs, prev.endMs, state.metric))
		: null;
	const stats = stackStats(model, prevTotal);
	const unitNoun = UNIT_NOUN[model.unit];

	// Headline, tokcat-style: big numbers first, context after.
	const accent = (s: string) => th.fg("accent", th.bold(s));
	const segments: string[] = [`${accent(fmt(stats.total))} ${th.fg("muted", `${state.metric === "cost" ? "total" : state.metric}`)}`];
	if (state.metric === "cost") {
		const tokens = memo(`sum|${state.period}|tokens`, () =>
			model.buckets.length ? sumMetricInRange(data.hourly, model.buckets[0]!.startMs, model.buckets[model.buckets.length - 1]!.endMs, "tokens") : 0
		);
		segments.push(`${accent(formatCount(tokens))} ${th.fg("muted", "tokens")}`);
	}
	segments.push(`${th.bold(String(stats.activeBuckets))}${th.fg("muted", `/${model.buckets.length} active ${unitNoun}s`)}`);
	if (stats.bestIdx >= 0) {
		segments.push(`${th.fg("muted", "best")} ${th.bold(fmt(stats.bestValue))} ${th.fg("dim", bucketTitle(model.buckets[stats.bestIdx]!, model.unit))}`);
	}
	if (stats.activeBuckets > 0) segments.push(`${th.fg("muted", "avg")} ${th.bold(fmt(stats.avgActive))}${th.fg("dim", `/active ${unitNoun}`)}`);
	if (model.unit === "day" && stats.longestStreak > 1) {
		segments.push(`${th.fg("muted", "streak")} ${th.bold(`${stats.currentStreak}d`)} ${th.fg("dim", `(best ${stats.longestStreak}d)`)}`);
	}
	if (prev && prevTotal !== null && prevTotal > 0) {
		const delta = ((stats.total - prevTotal) / prevTotal) * 100;
		const text = `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)}%`;
		segments.push(`${th.fg(delta >= 0 ? "warning" : "success", text)} ${th.fg("dim", `vs ${prev.label}`)}`);
	}
	lines.push(...flow(segments, width, th.fg("dim", "  ·  ")));

	const groupWord = state.groupBy === "provider" ? "provider" : "model";
	lines.push(
		th.fg(
			"dim",
			`${UNIT_ADJECTIVE[model.unit]} ${state.metric}${state.metric === "cost" ? " (list-priced)" : state.metric === "tokens" ? " (in + out + cache write)" : ""} · stacked by ${groupWord} · top ${state.topN} + other`
		)
	);
	lines.push("");

	if (model.grandTotal === 0) {
		lines.push(th.fg("dim", "  No usage data for this period"));
		lines.push("");
		return lines;
	}

	const selected = resolveCursor(plan, state.cursor);
	const colors = assignSeriesColors(model.series.map((s) => s.key));
	// Fixed rows: headline(≤2) + subtitle + blank + axis(2) + blank + legend(header + series + total) + blank.
	const legendRows = model.series.length + 2;
	const fixed = lines.length + 2 + 1 + legendRows + 1;
	const height = Math.max(5, Math.min(18, maxLines - fixed));
	lines.push(
		...renderStackedBars(model, {
			width: chartWidth(width),
			height,
			formatValue: fmtShort,
			formatBucket: bucketAxisLabel,
			selectedIdx: selected,
			paint: stackPainter(th, colors),
		})
	);
	lines.push("");

	// Legend: period totals + share, and the selected bucket's breakdown.
	const sel = selected >= 0 ? model.values[selected]! : [];
	const selTotal = selected >= 0 ? model.totals[selected]! : 0;
	const selTitle = selected >= 0 ? bucketTitle(model.buckets[selected]!, model.unit) : "";
	const valueW = 10;
	const barW = width >= 100 ? 14 : width >= 80 ? 8 : 0;
	const showSel = width >= 70;
	const nameW = Math.max(10, Math.min(26, width - (2 + valueW + 6 + (barW ? barW + 1 : 0) + (showSel ? valueW + 6 + 3 : 0))));
	const header =
		"  " +
		fit(groupWord, nameW) +
		fit("period", valueW, "right") +
		fit("share", 6, "right") +
		(barW ? " " + " ".repeat(barW) : "") +
		(showSel ? " │ " + fit(selTitle, valueW + 6, "right") : "");
	lines.push(th.fg("muted", header));
	for (let i = 0; i < model.series.length; i++) {
		// Largest first (bottom of the stack); "other" last.
		const s = model.series[i]!;
		const share = model.grandTotal > 0 ? s.total / model.grandTotal : 0;
		const selV = sel[i] ?? 0;
		const selShare = selTotal > 0 ? selV / selTotal : 0;
		let line = swatch(colors[i]!, "■") + " " + fit(s.label, nameW) + fit(fmt(s.total), valueW, "right") + th.fg("dim", fit(formatPct(share * 100, 0), 6, "right"));
		if (barW) line += " " + fgCode(colors[i]!) + padR(shareBar(share, barW), barW) + FG_RESET;
		if (showSel) {
			line +=
				th.fg("dim", " │ ") +
				(selV > 0 ? fit(fmt(selV), valueW, "right") + th.fg("dim", fit(formatPct(selShare * 100, 0), 6, "right")) : th.fg("dim", fit("–", valueW + 6, "right")));
		}
		lines.push(line);
	}
	let totalLine = "  " + th.bold(fit("Total", nameW)) + th.bold(fit(fmt(model.grandTotal), valueW, "right")) + " ".repeat(6);
	if (barW) totalLine += " " + " ".repeat(barW);
	if (showSel) totalLine += th.fg("dim", " │ ") + th.bold(fit(fmt(selTotal), valueW, "right"));
	lines.push(totalLine);
	lines.push("");
	return lines;
}

// =============================================================================
// Cache view
// =============================================================================

export interface CacheViewState {
	period: TabName;
	chart: CacheChart;
	groupBy: CacheGroupBy;
	cursor: number | null;
}

export function cacheModelFor(memo: Memo, data: UsageData, state: CacheViewState, width: number, rates: InputRates): CacheModel {
	const plan = planFor(memo, data, state.period, width);
	const capacity = stackPlotCapacity(chartWidth(width));
	return memo(`cache|${state.period}|${capacity}|${state.groupBy}`, () =>
		buildCacheModel(data.hourly, plan, rates, { groupBy: state.groupBy, hitSeriesCount: 4 })
	);
}

export function cacheStackFor(memo: Memo, data: UsageData, state: CacheViewState, width: number, rates: InputRates): StackModel {
	const plan = planFor(memo, data, state.period, width);
	const capacity = stackPlotCapacity(chartWidth(width));
	return memo(`cachestack|${state.period}|${capacity}|${state.chart}`, () => buildCacheStack(data.hourly, plan, state.chart, rates));
}

function hitGraphModel(model: CacheModel, plan: BucketPlan, visibleKeys: Set<string>): GraphModel {
	// Robust floor: the overall line's minimum, or the 10th percentile of the
	// per-row points, whichever is lower. A single outlier day (one tiny turn
	// with no cache hit) is clamped to the bottom edge instead of flattening
	// every other line into the top row.
	let lo = Number.POSITIVE_INFINITY;
	const rowPoints: number[] = [];
	for (const s of model.hitSeries) {
		if (!visibleKeys.has(s.key)) continue;
		for (const v of s.points) {
			if (!Number.isFinite(v)) continue;
			if (s.key === OVERALL_HIT_KEY) lo = Math.min(lo, v);
			else rowPoints.push(v);
		}
	}
	if (rowPoints.length > 0) {
		rowPoints.sort((a, b) => a - b);
		lo = Math.min(lo, rowPoints[Math.floor(rowPoints.length * 0.1)]!);
	}
	// Auto-range: hit rates usually cluster in the 90s; a 0–100 axis flattens them.
	let yMin = Number.isFinite(lo) ? Math.max(0, Math.floor((lo - 1) / 5) * 5) : 0;
	if (yMin > 90) yMin = 90;
	const n = plan.buckets.length;
	return {
		series: model.hitSeries.map((s) => {
			let firstIdx = -1;
			let lastIdx = -1;
			for (let i = 0; i < s.points.length; i++) {
				if (Number.isFinite(s.points[i])) {
					if (firstIdx === -1) firstIdx = i;
					lastIdx = i;
				}
			}
			return {
				key: s.key,
				label: s.label,
				points: s.points,
				// renderChart draws higher totals last; the overall line wins contested cells.
				total: s.key === OVERALL_HIT_KEY ? Number.MAX_VALUE : 1 / (1 + model.hitSeries.indexOf(s)),
				hidden: !visibleKeys.has(s.key),
				firstIdx,
				lastIdx,
			};
		}),
		bucketStarts: plan.buckets.map((b) => b.startMs),
		bucketMs: n > 0 ? (plan.buckets[n - 1]!.endMs - plan.buckets[0]!.startMs) / n : 0,
		domainStartMs: plan.buckets[0]?.startMs ?? 0,
		domainEndMs: plan.buckets[n - 1]?.startMs ?? 0,
		yMax: 100,
		yMin,
		groupedTotal: 0,
	};
}

function cacheSummary(th: Theme, t: CacheTotals, width: number, unpricedNote: boolean): string[] {
	const lines: string[] = [];
	const hit = hitPercent(t);
	const b = (s: string) => th.bold(s);
	const m = (s: string) => th.fg("muted", s);
	const sep = th.fg("dim", "  ·  ");
	const oneHourShare = t.cacheWrite > 0 ? (t.cacheWrite1h / t.cacheWrite) * 100 : 0;

	lines.push(
		...flow(
			[
				`${m("hit rate")} ${th.fg("accent", th.bold(formatPct(hit)))}`,
				`${b(formatCount(t.cacheRead))} ${m("cached reads")}`,
				`${b(formatCount(t.cacheWrite))} ${m("cache writes")}${t.cacheWrite1h > 0 ? th.fg("dim", ` (${oneHourShare.toFixed(0)}% 1h)`) : ""}`,
				`${b(formatCount(t.input))} ${m("uncached input")}`,
				`${b(formatCount(t.output))} ${m("output")}`,
			],
			width,
			sep
		)
	);

	const net = netSavings(t);
	const wouldBe = t.estCost + net;
	const pctCheaper = wouldBe > 0 ? (net / wouldBe) * 100 : 0;
	lines.push(
		...flow(
			[
				`${m("caching saved")} ${th.fg(net >= 0 ? "success" : "error", th.bold(`~${formatMoney(net)}`))}${th.fg("dim", wouldBe > 0 ? ` (${pctCheaper.toFixed(0)}% cheaper than uncached)` : "")}`,
				`${m("reads")} ${b(formatMoney(readSavings(t)))} ${th.fg("dim", "saved vs input price")}`,
				`${m("write premium")} ${b(formatMoney(writePremium(t)))}`,
			],
			width,
			sep
		)
	);

	const spend = t.estCost > 0 ? t.estCost : 1;
	const part = (label: string, v: number) => `${m(label)} ${b(formatMoney(v))}${th.fg("dim", ` ${((v / spend) * 100).toFixed(0)}%`)}`;
	lines.push(
		...flow(
			[
				`${m("spend")} ${b(formatMoney(t.estCost))}${th.fg("dim", ":")}`,
				part("output", t.costOutput),
				part("cache write", t.costCacheWrite),
				part("cache read", t.costCacheRead),
				part("input", t.costInput),
				...(t.costUnsplit > 0 ? [part("unattributed", t.costUnsplit)] : []),
			],
			width,
			sep
		)
	);

	const misses = missCount(t);
	lines.push(
		...flow(
			[
				`${m("cache misses")} ${b(misses.toLocaleString("en-US"))} ${m("turns,")} ${b(formatMoney(missCost(t)))}`,
				`${th.fg("dim", "idle >5m")} ${t.missTtl.toLocaleString("en-US")} ${th.fg("dim", `(${formatMoney(t.missTtlCost)})`)}`,
				`${th.fg("dim", "model switch")} ${t.missSwitch.toLocaleString("en-US")} ${th.fg("dim", `(${formatMoney(t.missSwitchCost)})`)}`,
				`${th.fg("dim", "prefix changed")} ${t.missPrefix.toLocaleString("en-US")} ${th.fg("dim", `(${formatMoney(t.missPrefixCost)})`)}`,
			],
			width,
			sep
		)
	);

	const excluded: string[] = [];
	if (unpricedNote) excluded.push(`${formatCount(t.unpricedCacheRead)} reads with no input price (from savings)`);
	if (t.unreportedPrompt > 0) excluded.push(`${formatCount(t.unreportedPrompt)} prompt tokens from providers that report no cache data (from hit rate)`);
	if (excluded.length > 0) {
		const flowed = flow(excluded.map((e) => th.fg("dim", e)), width, th.fg("dim", " · "), "          ");
		flowed[0] = th.fg("dim", "excluded: ") + flowed[0]!.slice(10);
		lines.push(...flowed);
	}
	return lines;
}

interface CacheColumn {
	label: string;
	width: number;
	/** Lower drops first when the terminal is narrow. */
	priority: number;
	value: (t: CacheTotals) => string;
}

const CACHE_COLUMNS: CacheColumn[] = [
	{ label: "Hit%", width: 6, priority: 10, value: (t) => (promptTokens(t) === 0 && t.unreportedPrompt > 0 ? "n/a" : formatPct(hitPercent(t))) },
	{ label: "Read", width: 7, priority: 8, value: (t) => formatCount(t.cacheRead) },
	{ label: "Write", width: 7, priority: 6, value: (t) => formatCount(t.cacheWrite) },
	{ label: "1h%", width: 5, priority: 2, value: (t) => (t.cacheWrite > 0 ? `${((t.cacheWrite1h / t.cacheWrite) * 100).toFixed(0)}%` : "–") },
	{ label: "Fresh", width: 7, priority: 4, value: (t) => formatCount(t.input) },
	{ label: "Cache $", width: 9, priority: 7, value: (t) => formatMoneyShort(t.costCacheRead + t.costCacheWrite) },
	{ label: "Saved", width: 9, priority: 9, value: (t) => formatMoneyShort(netSavings(t)) },
	{ label: "Miss", width: 6, priority: 5, value: (t) => missCount(t).toLocaleString("en-US") },
	{ label: "Miss $", width: 8, priority: 3, value: (t) => formatMoneyShort(missCost(t)) },
];

export function renderCacheView(
	th: Theme,
	data: UsageData,
	state: CacheViewState,
	width: number,
	maxLines: number,
	memo: Memo,
	rates: InputRates
): string[] {
	const plan = planFor(memo, data, state.period, width);
	const model = cacheModelFor(memo, data, state, width, rates);
	const stack = cacheStackFor(memo, data, state, width, rates);
	const lines: string[] = [];

	if (promptTokens(model.totals) === 0 && model.totals.estCost === 0) {
		lines.push(th.fg("dim", "  No usage data for this period"));
		lines.push("");
		return lines;
	}

	lines.push(...cacheSummary(th, model.totals, width, model.totals.unpricedCacheRead > 0));
	lines.push("");

	const selected = resolveCursor(plan, state.cursor);
	const tableRows = Math.min(model.rows.length, 8);
	// summary + blank + title + chart axis(2) + legend + blank + hit title + hit axis(1) + legend + blank + detail + blank + table(2 + rows)
	const fixed = lines.length + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 2;
	let room = Math.max(0, maxLines - fixed);
	const rowsShown = Math.max(0, Math.min(tableRows, room - 8));
	room -= rowsShown;
	const barH = Math.max(4, Math.min(12, Math.round(room * 0.6)));
	const hitH = Math.max(3, Math.min(8, room - barH));

	// 1) Stacked composition.
	const compColors = CACHE_CHART_COLORS[state.chart];
	lines.push(th.fg("muted", `${UNIT_ADJECTIVE[stack.unit]} ${CACHE_CHART_LABELS[state.chart]}`) + th.fg("dim", "   [m] cycle"));
	if (stack.grandTotal > 0) {
		const fmtShort = state.chart === "tokens" ? formatCount : formatMoneyShort;
		lines.push(
			...renderStackedBars(stack, {
				width: chartWidth(width),
				height: barH,
				formatValue: fmtShort,
				formatBucket: bucketAxisLabel,
				selectedIdx: selected,
				paint: stackPainter(th, compColors),
			})
		);
		const legend = stack.series.map((s, i) => {
			const share = stack.grandTotal > 0 ? (s.total / stack.grandTotal) * 100 : 0;
			return `${swatch(compColors[i]!, "■")} ${s.label} ${th.fg("dim", `${fmtShort(s.total)} ${share.toFixed(0)}%`)}`;
		});
		lines.push(...flow(legend, width, "   ", "  "));
	} else {
		lines.push(th.fg("dim", "  nothing recorded for this chart in this period"));
	}
	lines.push("");

	// 2) Hit-rate lines, overall + top rows.
	const visibleHit = new Set(model.hitSeries.map((s) => s.key));
	const hitModel = hitGraphModel(model, plan, visibleHit);
	const hitColors = assignSeriesColors(model.hitSeries.map((s) => s.key));
	lines.push(th.fg("muted", `Cache hit rate per ${UNIT_NOUN[plan.unit]}`) + th.fg("dim", ` · y-axis ${hitModel.yMin ?? 0}–100%`));
	const barLayout = stackLayout(stack, { width: chartWidth(width), height: barH, formatValue: formatMoneyShort });
	const hitLines = renderChart(hitModel, {
		width: Math.max(30, barLayout.axisWidth + barLayout.plotWidth),
		height: hitH,
		formatValue: (v) => `${Math.round(v)}%`,
		formatTime: (ms) => bucketAxisLabel(ms, plan.unit),
		colorize: (i, text) => (i < 0 ? th.fg("dim", text) : fgCode(hitColors[i] ?? OTHER_COLOR) + text + FG_RESET),
	});
	lines.push(...hitLines);
	const hitLegend = model.hitSeries.map((s, i) => {
		const row = s.key === OVERALL_HIT_KEY ? model.totals : model.rows.find((r) => r.key === s.key)?.totals;
		return `${swatch(hitColors[i]!)} ${s.key === OVERALL_HIT_KEY ? th.bold(s.label) : s.label} ${th.fg("dim", row ? formatPct(hitPercent(row)) : "")}`;
	});
	lines.push(...flow(hitLegend, width, "   ", "  "));
	lines.push("");

	// 3) Selected bucket detail.
	if (selected >= 0) {
		const t = model.buckets[selected]!;
		const title = bucketTitle(plan.buckets[selected]!, plan.unit);
		const parts =
			promptTokens(t) === 0 && t.estCost === 0
				? [th.fg("dim", "no usage")]
				: [
						`hit ${th.bold(formatPct(hitPercent(t)))}`,
						`read ${formatCount(t.cacheRead)}`,
						`write ${formatCount(t.cacheWrite)}${t.cacheWrite1h > 0 ? th.fg("dim", ` (${((t.cacheWrite1h / t.cacheWrite) * 100).toFixed(0)}% 1h)`) : ""}`,
						`fresh ${formatCount(t.input)}`,
						`spend ${formatMoney(t.estCost)}`,
						`saved ${th.fg("success", formatMoney(netSavings(t)))}`,
						`misses ${missCount(t)}${missCount(t) > 0 ? th.fg("dim", ` (${formatMoney(missCost(t))})`) : ""}`,
					];
		lines.push(...flow([th.fg("accent", th.bold(`▲ ${title}`)), ...parts], width, th.fg("dim", " · ")));
		lines.push("");
	}

	// 4) Per provider/model table.
	if (rowsShown > 0) {
		const nameW = 20;
		let columns = CACHE_COLUMNS.slice();
		const tableWidth = (cols: CacheColumn[]) => 2 + nameW + cols.reduce((s, c) => s + c.width + 1, 0);
		while (columns.length > 2 && tableWidth(columns) > width) {
			const drop = columns.reduce((lo, c) => (c.priority < lo.priority ? c : lo), columns[0]!);
			columns = columns.filter((c) => c !== drop);
		}
		const header = "  " + fit(state.groupBy === "provider" ? "Provider" : "Model", nameW) + columns.map((c) => " " + fit(c.label, c.width, "right")).join("");
		lines.push(th.fg("muted", header));
		lines.push(th.fg("border", "─".repeat(Math.min(width, tableWidth(columns)))));
		const rowColors = assignSeriesColors(model.rows.map((r) => r.key));
		for (let i = 0; i < rowsShown; i++) {
			const row = model.rows[i]!;
			lines.push(swatch(rowColors[i]!, "■") + " " + fit(row.label, nameW) + columns.map((c) => " " + fit(c.value(row.totals), c.width, "right")).join(""));
		}
		if (model.rows.length > rowsShown) lines.push(th.fg("dim", `  … ${model.rows.length - rowsShown} more (widen/heighten the terminal or export with [e])`));
		lines.push("");
	}
	return lines;
}
