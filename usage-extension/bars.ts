/**
 * Stacked bar charts for /usage: a tokcat-style "daily usage, stacked by
 * provider" view plus the generic bucket/stack machinery the cache view reuses.
 *
 * Pure and theme-free like graph.ts: models are built from data.ts hourly
 * buckets, and the renderer emits text through a paint callback so the UI
 * layer owns colours. Bars use eighth-block glyphs with a foreground/background
 * colour pair per cell, so two stacked segments can meet inside one terminal
 * cell at 1/8-row resolution.
 */

import type { HourlyCell, HourlyKey, PeriodBounds, TabName } from "./data.ts";
import { AUXILIARY_PROVIDER, splitHourlyKey } from "./data.ts";

// =============================================================================
// Buckets
// =============================================================================

export type BucketUnit = "hour" | "day" | "week" | "month";

export interface Bucket {
	startMs: number;
	endMs: number;
}

export interface BucketPlan {
	unit: BucketUnit;
	buckets: Bucket[];
	/** Index of the bucket containing `bounds.nowMs`, or -1 if outside. */
	nowIdx: number;
}

const HOUR_MS = 3_600_000;

function startOfLocalDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function addLocalDays(ms: number, days: number): number {
	const d = new Date(ms);
	d.setDate(d.getDate() + days);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfLocalWeek(ms: number): number {
	const d = new Date(startOfLocalDay(ms));
	const dow = d.getDay();
	d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
	return d.getTime();
}

function startOfLocalMonth(ms: number): number {
	const d = new Date(ms);
	d.setDate(1);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function addLocalMonths(ms: number, months: number): number {
	const d = new Date(ms);
	d.setMonth(d.getMonth() + months, 1);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function firstActivityMs(hourly: Map<number, Map<HourlyKey, HourlyCell>>, fallback: number): number {
	let first = Number.POSITIVE_INFINITY;
	for (const hour of hourly.keys()) if (hour < first) first = hour;
	return Number.isFinite(first) ? first : fallback;
}

function spanBuckets(startMs: number, endMs: number, unit: BucketUnit): Bucket[] {
	const out: Bucket[] = [];
	let cursor = startMs;
	while (cursor < endMs) {
		const next =
			unit === "hour"
				? cursor + HOUR_MS
				: unit === "day"
					? addLocalDays(cursor, 1)
					: unit === "week"
						? addLocalDays(cursor, 7)
						: addLocalMonths(cursor, 1);
		out.push({ startMs: cursor, endMs: next });
		cursor = next;
	}
	return out;
}

/**
 * Calendar-aligned buckets for a period: hours for Today, local days otherwise.
 * When there are more days than `maxBuckets` columns, coarsen to weeks, then
 * months. Week/month periods always show their full calendar span (future
 * buckets stay empty) so the layout is stable through the week.
 */
export function planBuckets(
	period: TabName,
	bounds: PeriodBounds,
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	maxBuckets: number
): BucketPlan {
	const max = Math.max(1, Math.floor(maxBuckets));
	let startMs: number;
	let endMs: number;
	let unit: BucketUnit = "day";
	switch (period) {
		case "today":
			startMs = bounds.todayMs;
			endMs = addLocalDays(bounds.todayMs, 1);
			unit = "hour";
			break;
		case "thisWeek":
			startMs = bounds.weekStartMs;
			endMs = addLocalDays(bounds.weekStartMs, 7);
			break;
		case "lastWeek":
			startMs = bounds.lastWeekStartMs;
			endMs = bounds.weekStartMs;
			break;
		case "last30Days":
			startMs = bounds.last30DaysStartMs;
			endMs = addLocalDays(bounds.todayMs, 1);
			break;
		case "allTime":
			startMs = startOfLocalDay(Math.min(firstActivityMs(hourly, bounds.todayMs), bounds.todayMs));
			endMs = addLocalDays(bounds.todayMs, 1);
			break;
	}

	let buckets = spanBuckets(startMs, endMs, unit);
	if (unit === "hour" && buckets.length > max) {
		// Very narrow terminal: fall back to one bucket for the whole day.
		buckets = [{ startMs, endMs }];
		unit = "day";
	}
	if (unit === "day" && buckets.length > max) {
		unit = "week";
		buckets = spanBuckets(startOfLocalWeek(startMs), endMs, "week");
	}
	if (unit === "week" && buckets.length > max) {
		unit = "month";
		buckets = spanBuckets(startOfLocalMonth(startMs), endMs, "month");
	}
	if (buckets.length > max) buckets = buckets.slice(buckets.length - max);

	const now = bounds.nowMs;
	const nowIdx = buckets.findIndex((b) => now >= b.startMs && now < b.endMs);
	return { unit, buckets, nowIdx };
}

/**
 * Index into `buckets` for an hour start, by binary search. Buckets are
 * contiguous and ascending. Returns -1 when outside the plan.
 */
export function bucketIndexOf(buckets: Bucket[], hourMs: number): number {
	let lo = 0;
	let hi = buckets.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const b = buckets[mid]!;
		if (hourMs < b.startMs) hi = mid - 1;
		else if (hourMs >= b.endMs) lo = mid + 1;
		else return mid;
	}
	return -1;
}

// =============================================================================
// Stack model
// =============================================================================

export type StackMetric = "cost" | "tokens" | "messages";
export type StackGroupBy = "provider" | "model";

export const STACK_METRIC_ORDER: StackMetric[] = ["cost", "tokens", "messages"];
export const STACK_GROUP_ORDER: StackGroupBy[] = ["provider", "model"];
export const STACK_METRIC_LABELS: Record<StackMetric, string> = {
	cost: "cost",
	tokens: "tokens",
	messages: "messages",
};

export const STACK_OTHER_KEY = "\u0000other";
export const DEFAULT_TOP_N = 5;
export const MIN_TOP_N = 1;
export const MAX_TOP_N = 8;

export interface StackSeries {
	key: string;
	label: string;
	/** Period total for this series. */
	total: number;
}

export interface StackModel {
	unit: BucketUnit;
	buckets: Bucket[];
	nowIdx: number;
	/** Bottom-to-top stacking order; "other" (if any) is last. */
	series: StackSeries[];
	/** values[bucketIdx][seriesIdx]. */
	values: number[][];
	/** Per-bucket stacked total. */
	totals: number[];
	yMax: number;
	grandTotal: number;
}

export function stackMetricOf(cell: HourlyCell, metric: StackMetric): number {
	switch (metric) {
		case "cost":
			return cell.estCost;
		case "tokens":
			// Same "fresh tokens" definition as the table and line graphs.
			return cell.input + cell.output + cell.cacheWrite;
		case "messages":
			return cell.messages;
	}
}

function stackGroupKey(key: HourlyKey, groupBy: StackGroupBy): string {
	const { provider, model } = splitHourlyKey(key);
	return groupBy === "provider" ? provider : model;
}

/**
 * Generic stacker: `extract` returns (seriesKey, value) contributions for each
 * hourly cell. Series are ranked by period total; the top `topN` keep their
 * own stack segment and the rest merge into "other". The synthetic Tools
 * provider sorts after real series of the same rank group.
 */
export function buildStack(
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	plan: BucketPlan,
	extract: (key: HourlyKey, cell: HourlyCell, emit: (seriesKey: string, value: number) => void) => void,
	options: { topN?: number; fixedOrder?: { key: string; label: string }[] } = {}
): StackModel {
	const n = plan.buckets.length;
	const perSeries = new Map<string, number[]>();
	const seriesTotals = new Map<string, number>();
	const rangeStart = plan.buckets[0]?.startMs ?? 0;
	const rangeEnd = plan.buckets[n - 1]?.endMs ?? 0;

	for (const [hour, bucket] of hourly) {
		if (hour < rangeStart || hour >= rangeEnd) continue;
		const idx = bucketIndexOf(plan.buckets, hour);
		if (idx < 0) continue;
		for (const [key, cell] of bucket) {
			extract(key, cell, (seriesKey, value) => {
				if (!value) return;
				let points = perSeries.get(seriesKey);
				if (!points) {
					points = new Array<number>(n).fill(0);
					perSeries.set(seriesKey, points);
				}
				points[idx] = points[idx]! + value;
				seriesTotals.set(seriesKey, (seriesTotals.get(seriesKey) ?? 0) + value);
			});
		}
	}

	let series: StackSeries[];
	let columns: number[][];
	if (options.fixedOrder) {
		series = options.fixedOrder.map(({ key, label }) => ({ key, label, total: seriesTotals.get(key) ?? 0 }));
		columns = options.fixedOrder.map(({ key }) => perSeries.get(key) ?? new Array<number>(n).fill(0));
	} else {
		const topN = Math.max(MIN_TOP_N, options.topN ?? DEFAULT_TOP_N);
		const ranked = Array.from(seriesTotals.entries())
			.filter(([, total]) => total > 0)
			.sort((a, b) => {
				const aAux = a[0] === AUXILIARY_PROVIDER ? 1 : 0;
				const bAux = b[0] === AUXILIARY_PROVIDER ? 1 : 0;
				return b[1] - a[1] || aAux - bAux || a[0].localeCompare(b[0]);
			});
		const kept = ranked.slice(0, topN);
		const merged = ranked.slice(topN);
		series = kept.map(([key, total]) => ({ key, label: key, total }));
		columns = kept.map(([key]) => perSeries.get(key)!);
		if (merged.length > 0) {
			const other = new Array<number>(n).fill(0);
			let total = 0;
			for (const [key, t] of merged) {
				const pts = perSeries.get(key)!;
				for (let i = 0; i < n; i++) other[i] = other[i]! + pts[i]!;
				total += t;
			}
			series.push({ key: STACK_OTHER_KEY, label: `other (${merged.length})`, total });
			columns.push(other);
		}
	}

	const values: number[][] = [];
	const totals: number[] = [];
	let yMax = 0;
	let grandTotal = 0;
	for (let b = 0; b < n; b++) {
		const row = columns.map((col) => col[b]!);
		const sum = row.reduce((acc, v) => acc + v, 0);
		values.push(row);
		totals.push(sum);
		grandTotal += sum;
		if (sum > yMax) yMax = sum;
	}

	return { unit: plan.unit, buckets: plan.buckets, nowIdx: plan.nowIdx, series, values, totals, yMax, grandTotal };
}

/** The tokcat-style view: metric stacked by provider (or model), top N + other. */
export function buildUsageStack(
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	plan: BucketPlan,
	metric: StackMetric,
	groupBy: StackGroupBy,
	topN: number
): StackModel {
	return buildStack(hourly, plan, (key, cell, emit) => emit(stackGroupKey(key, groupBy), stackMetricOf(cell, metric)), { topN });
}

// =============================================================================
// Summary stats (headline numbers above the chart)
// =============================================================================

export interface StackStats {
	total: number;
	/** Buckets with any value > 0. */
	activeBuckets: number;
	/** Average over active buckets. */
	avgActive: number;
	bestIdx: number;
	bestValue: number;
	/** Consecutive active buckets ending at now (or the bucket before it). */
	currentStreak: number;
	longestStreak: number;
	/** Same-length window immediately before this period; null when not meaningful. */
	previousTotal: number | null;
}

export function stackStats(model: StackModel, previousTotal: number | null = null): StackStats {
	let active = 0;
	let bestIdx = -1;
	let bestValue = 0;
	let longest = 0;
	let run = 0;
	for (let i = 0; i < model.totals.length; i++) {
		const v = model.totals[i]!;
		if (v > 0) {
			active++;
			run++;
			if (run > longest) longest = run;
		} else {
			run = 0;
		}
		if (v > bestValue) {
			bestValue = v;
			bestIdx = i;
		}
	}
	// Current streak counts back from "now"; an idle today does not break a
	// streak that ran through yesterday.
	let current = 0;
	const lastIdx = model.nowIdx >= 0 ? model.nowIdx : model.totals.length - 1;
	let i = lastIdx;
	if (i >= 0 && model.totals[i] === 0) i--;
	while (i >= 0 && model.totals[i]! > 0) {
		current++;
		i--;
	}
	return {
		total: model.grandTotal,
		activeBuckets: active,
		avgActive: active > 0 ? model.grandTotal / active : 0,
		bestIdx,
		bestValue,
		currentStreak: current,
		longestStreak: longest,
		previousTotal,
	};
}

/** Sum of `metric` over [startMs, endMs) — used for period-over-period deltas. */
export function sumMetricInRange(
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	startMs: number,
	endMs: number,
	metric: StackMetric
): number {
	let sum = 0;
	for (const [hour, bucket] of hourly) {
		if (hour < startMs || hour >= endMs) continue;
		for (const cell of bucket.values()) sum += stackMetricOf(cell, metric);
	}
	return sum;
}

// =============================================================================
// Renderer
// =============================================================================

/** Paint target: a series index, or one of the furniture codes. */
export const PAINT_NONE = -1;
export const PAINT_AXIS = -2;
export const PAINT_MARK = -3;
export const PAINT_LABEL = -4;

/**
 * Style a run of text. `fg`/`bg` are series indices or PAINT_* codes;
 * PAINT_NONE as bg means the terminal default background.
 */
export type StackPaint = (fg: number, bg: number, text: string) => string;

export interface StackRenderOptions {
	width: number;
	/** Plot rows (each row = 8 vertical sub-steps). */
	height: number;
	formatValue: (value: number) => string;
	/** Short x-axis label for a bucket start. */
	formatBucket: (startMs: number, unit: BucketUnit) => string;
	/** Highlighted bucket (cursor), or -1. */
	selectedIdx?: number;
	paint?: StackPaint;
	/** Max bar width in cells; default 7. */
	maxBarWidth?: number;
	/**
	 * Never emit background colours. Surfaces that replace SGR backgrounds with
	 * a highlight (pi-hud's native canvas) would otherwise smear segment joins;
	 * each cell instead takes the colour of the segment covering most of it.
	 */
	noBackground?: boolean;
}

export interface StackLayout {
	axisWidth: number;
	slot: number;
	barWidth: number;
	plotWidth: number;
	labelWidth: number;
}

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Columns available for buckets at a given total width (used to plan buckets). */
export function stackPlotCapacity(width: number, yLabelWidth = 7): number {
	return Math.max(1, width - (yLabelWidth + 2));
}

export function stackLayout(model: StackModel, options: Pick<StackRenderOptions, "width" | "height" | "formatValue" | "maxBarWidth">): StackLayout {
	const labelWidth = Math.max(
		options.formatValue(model.yMax).length,
		options.formatValue(model.yMax / 2).length,
		options.formatValue(0).length
	);
	const axisWidth = labelWidth + 2;
	const available = Math.max(options.width - axisWidth, 1);
	const n = Math.max(model.buckets.length, 1);
	const slot = Math.max(1, Math.floor(available / n));
	const maxBar = Math.max(1, options.maxBarWidth ?? 7);
	const barWidth = slot >= 3 ? Math.min(slot - 1, maxBar) : 1;
	return { axisWidth, slot, barWidth, plotWidth: slot * n, labelWidth };
}

interface CellPaint {
	ch: string;
	fg: number;
	bg: number;
}

/** Bucket index for a plot column, or -1 for gap columns. */
function bucketAtColumn(col: number, layout: StackLayout, n: number): number {
	const b = Math.floor(col / layout.slot);
	if (b >= n) return -1;
	const offset = col - b * layout.slot;
	// Centre the bar inside its slot (gap split evenly, extra on the right).
	const lead = Math.floor((layout.slot - layout.barWidth) / 2);
	return offset >= lead && offset < lead + layout.barWidth ? b : -1;
}

/**
 * Render stacked bars. Returns height + 2 lines: plot rows, an axis row with
 * the selection marker, and an x-label row.
 */
export function renderStackedBars(model: StackModel, options: StackRenderOptions): string[] {
	const paint: StackPaint = options.paint ?? ((_fg, _bg, text) => text);
	const height = Math.max(2, options.height);
	const layout = stackLayout(model, options);
	const n = model.buckets.length;
	const units = height * 8;
	const yMax = model.yMax > 0 ? model.yMax : 1;
	const selected = options.selectedIdx ?? -1;

	// Segment boundaries per bucket in eighth-units, monotone non-decreasing.
	const bounds: number[][] = model.values.map((row) => {
		const out: number[] = [];
		let cum = 0;
		let prev = 0;
		for (const v of row) {
			cum += v;
			const u = Math.max(prev, Math.min(units, Math.round((cum / yMax) * units)));
			out.push(u);
			prev = u;
		}
		return out;
	});
	// A non-empty bucket always shows at least a sliver.
	for (let b = 0; b < n; b++) {
		const bb = bounds[b]!;
		if (model.totals[b]! > 0 && (bb[bb.length - 1] ?? 0) === 0) {
			const firstNonZero = model.values[b]!.findIndex((v) => v > 0);
			for (let k = firstNonZero; k < bb.length; k++) bb[k] = 1;
		}
	}

	const segmentAt = (b: number, unit: number): number => {
		const bb = bounds[b]!;
		for (let k = 0; k < bb.length; k++) if (unit < bb[k]!) return k;
		return PAINT_NONE;
	};

	const cellFor = (b: number, row: number): CellPaint => {
		const lo = row * 8;
		const lower = segmentAt(b, lo);
		if (lower === PAINT_NONE) return { ch: " ", fg: PAINT_NONE, bg: PAINT_NONE };
		const upper = segmentAt(b, lo + 7);
		if (upper === lower) return { ch: EIGHTHS[8], fg: lower, bg: PAINT_NONE };
		const fill = Math.max(1, Math.min(7, bounds[b]![lower]! - lo));
		if (!options.noBackground) return { ch: EIGHTHS[fill]!, fg: lower, bg: upper };
		// Foreground-only: glyph height = where the whole stack ends in this cell,
		// colour = the segment with the most eighths inside it.
		const bb = bounds[b]!;
		const top = bb[bb.length - 1] ?? 0;
		const height = Math.max(1, Math.min(8, top - lo));
		let best = lower;
		let bestUnits = 0;
		let prev = 0;
		for (let k = 0; k < bb.length; k++) {
			const units = Math.max(0, Math.min(bb[k]!, lo + 8) - Math.max(prev, lo));
			if (units > bestUnits) {
				best = k;
				bestUnits = units;
			}
			prev = bb[k]!;
		}
		return { ch: EIGHTHS[height]!, fg: best, bg: PAINT_NONE };
	};

	const yLabel = (row: number): string => {
		// row counted from the top.
		if (row === 0) return options.formatValue(model.yMax);
		if (row === Math.floor((height - 1) / 2) && height > 3) return options.formatValue(model.yMax * ((height - 1 - row) / (height - 1)));
		if (row === height - 1) return options.formatValue(0);
		return "";
	};

	const lines: string[] = [];
	for (let top = 0; top < height; top++) {
		const row = height - 1 - top;
		const label = yLabel(top);
		let line = paint(PAINT_AXIS, PAINT_NONE, label.padStart(layout.labelWidth) + (label ? " ┤" : " │"));
		let runFg = Number.NaN;
		let runBg = Number.NaN;
		let runText = "";
		const flush = () => {
			if (!runText) return;
			line += runFg === PAINT_NONE && runBg === PAINT_NONE ? runText : paint(runFg, runBg, runText);
			runText = "";
		};
		for (let col = 0; col < layout.plotWidth; col++) {
			const b = bucketAtColumn(col, layout, n);
			const cell = b < 0 ? { ch: " ", fg: PAINT_NONE, bg: PAINT_NONE } : cellFor(b, row);
			if (cell.fg !== runFg || cell.bg !== runBg) {
				flush();
				runFg = cell.fg;
				runBg = cell.bg;
			}
			runText += cell.ch;
		}
		flush();
		lines.push(line);
	}

	// Axis row: baseline with a ▲ under the selected bucket.
	let axis = paint(PAINT_AXIS, PAINT_NONE, " ".repeat(layout.labelWidth) + " └");
	let baseline = "";
	let markerCols: [number, number] | null = null;
	for (let col = 0; col < layout.plotWidth; col++) {
		const b = bucketAtColumn(col, layout, n);
		if (b === selected && b >= 0) {
			if (!markerCols) markerCols = [col, col];
			else markerCols[1] = col;
		}
	}
	if (markerCols) {
		const [a, z] = markerCols;
		const mid = Math.floor((a + z) / 2);
		baseline = paint(PAINT_AXIS, PAINT_NONE, "─".repeat(mid)) + paint(PAINT_MARK, PAINT_NONE, "▲") + paint(PAINT_AXIS, PAINT_NONE, "─".repeat(Math.max(layout.plotWidth - mid - 1, 0)));
	} else {
		baseline = paint(PAINT_AXIS, PAINT_NONE, "─".repeat(layout.plotWidth));
	}
	axis += baseline;
	lines.push(axis);

	lines.push(renderBucketLabels(model, layout, options, selected, paint));
	return lines;
}

function renderBucketLabels(
	model: StackModel,
	layout: StackLayout,
	options: StackRenderOptions,
	selected: number,
	paint: StackPaint
): string {
	const n = model.buckets.length;
	const prefix = " ".repeat(layout.axisWidth);
	if (n === 0) return prefix;
	const labels = model.buckets.map((b) => options.formatBucket(b.startMs, model.unit));
	const labelW = Math.max(...labels.map((l) => l.length), 1);
	const centreCol = (b: number) => b * layout.slot + Math.floor(layout.slot / 2);
	const chars = new Array<string>(layout.plotWidth).fill(" ");
	const owner = new Array<number>(layout.plotWidth).fill(-1);
	const tryPlace = (b: number): boolean => {
		const text = labels[b]!;
		let start = centreCol(b) - Math.floor(text.length / 2);
		start = Math.max(0, Math.min(start, layout.plotWidth - text.length));
		if (start < 0) return false;
		for (let c = Math.max(0, start - 1); c < Math.min(layout.plotWidth, start + text.length + 1); c++) {
			if (owner[c] !== -1) return false;
		}
		for (let i = 0; i < text.length; i++) {
			chars[start + i] = text[i]!;
			owner[start + i] = b;
		}
		return true;
	};
	// Selected first, then ends, then an even stride.
	if (selected >= 0 && selected < n) tryPlace(selected);
	tryPlace(n - 1);
	tryPlace(0);
	const stride = Math.max(1, Math.ceil((labelW + 2) / layout.slot));
	for (let b = stride; b < n - 1; b += stride) tryPlace(b);

	let out = prefix;
	let runOwnerSel = false;
	let run = "";
	const flush = () => {
		if (!run) return;
		out += paint(runOwnerSel ? PAINT_MARK : PAINT_LABEL, PAINT_NONE, run);
		run = "";
	};
	for (let c = 0; c < layout.plotWidth; c++) {
		const isSel = owner[c] === selected && selected >= 0;
		if (isSel !== runOwnerSel) {
			flush();
			runOwnerSel = isSel;
		}
		run += chars[c];
	}
	flush();
	return out;
}
