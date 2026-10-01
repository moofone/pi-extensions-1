/**
 * Prompt-cache analytics for /usage.
 *
 * Everything derives from the hourly cells built in data.ts, so a view switch
 * or period change is one pass over ~thousands of cells — no session re-scan.
 *
 * Definitions (all per period):
 *   prompt tokens  = input + cacheRead + cacheWrite
 *   hit%           = cacheRead / prompt tokens
 *   read savings   = cacheRead × inputRate − cost(cacheRead)
 *   write premium  = cost(cacheWrite) − cacheWrite × inputRate
 *   net savings    = read savings − write premium   ("vs. sending it all uncached")
 * inputRate is the model's observed fresh-input $/token (recorded breakdowns),
 * falling back to the catalog rate.
 */

import type { HourlyCell, HourlyKey } from "./data.ts";
import { AUXILIARY_PROVIDER, splitHourlyKey } from "./data.ts";
import { catalogInputRate } from "./sources.ts";
import type { BucketPlan, StackModel } from "./bars.ts";
import { bucketIndexOf, buildStack } from "./bars.ts";

// =============================================================================
// Totals
// =============================================================================

export interface CacheTotals {
	messages: number;
	estCost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costUnsplit: number;
	/** Σ cacheRead × inputRate (what the cached reads would have cost uncached). */
	readAtInputRate: number;
	/** Σ cacheWrite × inputRate. */
	writeAtInputRate: number;
	/** cacheRead tokens whose model has no known input rate (excluded from savings). */
	unpricedCacheRead: number;
	/** Prompt tokens from models that never report cache tokens (excluded from hit%). */
	unreportedPrompt: number;
	missTtl: number;
	missSwitch: number;
	missPrefix: number;
	missTtlCost: number;
	missSwitchCost: number;
	missPrefixCost: number;
}

export function emptyCacheTotals(): CacheTotals {
	return {
		messages: 0,
		estCost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		costUnsplit: 0,
		readAtInputRate: 0,
		writeAtInputRate: 0,
		unpricedCacheRead: 0,
		unreportedPrompt: 0,
		missTtl: 0,
		missSwitch: 0,
		missPrefix: 0,
		missTtlCost: 0,
		missSwitchCost: 0,
		missPrefixCost: 0,
	};
}

export function promptTokens(t: Pick<CacheTotals, "input" | "cacheRead" | "cacheWrite">): number {
	return t.input + t.cacheRead + t.cacheWrite;
}

/** Hit rate in percent, or NaN when there was no prompt input. */
export function hitPercent(t: Pick<CacheTotals, "input" | "cacheRead" | "cacheWrite">): number {
	const p = promptTokens(t);
	return p > 0 ? (t.cacheRead / p) * 100 : Number.NaN;
}

export function readSavings(t: CacheTotals): number {
	return t.readAtInputRate - t.costCacheRead;
}

export function writePremium(t: CacheTotals): number {
	return t.costCacheWrite - t.writeAtInputRate;
}

export function netSavings(t: CacheTotals): number {
	return readSavings(t) - writePremium(t);
}

export function missCount(t: CacheTotals): number {
	return t.missTtl + t.missSwitch + t.missPrefix;
}

export function missCost(t: CacheTotals): number {
	return t.missTtlCost + t.missSwitchCost + t.missPrefixCost;
}

// =============================================================================
// Input-rate resolution
// =============================================================================

/**
 * Period-independent context, built once per data load:
 *  - rates: $/token fresh-input rate per `${provider}\0${model}`
 *  - reporting: providers that ever reported cache tokens. Others (e.g.
 *    Cursor) are left out of hit-rate math so "no data" never reads as "0% hit".
 */
export interface InputRates {
	rates: Map<string, number>;
	reporting: Set<string>;
}

function rateKey(provider: string, model: string): string {
	return provider + "\u0000" + model;
}

/**
 * Observed fresh-input rate per model across all history: Σ cost(input) / Σ input
 * over cells that recorded both. Models with no observation use the catalog.
 * Build once per data load; it does not depend on the period.
 */
export function buildInputRates(hourly: Map<number, Map<HourlyKey, HourlyCell>>): InputRates {
	const sums = new Map<string, { cost: number; tokens: number }>();
	const seen = new Set<string>();
	const reporting = new Set<string>();
	for (const bucket of hourly.values()) {
		for (const [key, cell] of bucket) {
			const { provider, model } = splitHourlyKey(key);
			const k = rateKey(provider, model);
			seen.add(k);
			if (cell.cacheRead > 0 || cell.cacheWrite > 0) reporting.add(provider);
			// Only cells whose input cost came from a real breakdown are trustworthy;
			// a fully catalog-apportioned cell would just echo the catalog anyway.
			if (cell.input > 0 && cell.costInput > 0) {
				const s = sums.get(k) ?? { cost: 0, tokens: 0 };
				s.cost += cell.costInput;
				s.tokens += cell.input;
				sums.set(k, s);
			}
		}
	}
	const rates = new Map<string, number>();
	for (const k of seen) {
		const s = sums.get(k);
		if (s && s.tokens > 0) {
			rates.set(k, s.cost / s.tokens);
		} else {
			const [provider = "", model = ""] = k.split("\u0000");
			rates.set(k, catalogInputRate(provider, model));
		}
	}
	return { rates, reporting };
}

function addCell(t: CacheTotals, cell: HourlyCell, rate: number, reports: boolean): void {
	t.messages += cell.messages;
	t.estCost += cell.estCost;
	t.output += cell.output;
	if (reports) {
		t.input += cell.input;
		t.cacheRead += cell.cacheRead;
		t.cacheWrite += cell.cacheWrite;
		t.cacheWrite1h += cell.cacheWrite1h;
	} else {
		t.unreportedPrompt += cell.input + cell.cacheRead + cell.cacheWrite;
	}
	t.costInput += cell.costInput;
	t.costOutput += cell.costOutput;
	t.costCacheRead += cell.costCacheRead;
	t.costCacheWrite += cell.costCacheWrite;
	t.costUnsplit += cell.costUnsplit;
	if (rate > 0) {
		t.readAtInputRate += cell.cacheRead * rate;
		t.writeAtInputRate += cell.cacheWrite * rate;
	} else {
		t.unpricedCacheRead += cell.cacheRead;
		// No rate → no counterfactual: treat read/write as break-even.
		t.readAtInputRate += cell.costCacheRead;
		t.writeAtInputRate += cell.costCacheWrite;
	}
	t.missTtl += cell.missTtl;
	t.missSwitch += cell.missSwitch;
	t.missPrefix += cell.missPrefix;
	t.missTtlCost += cell.missTtlCost;
	t.missSwitchCost += cell.missSwitchCost;
	t.missPrefixCost += cell.missPrefixCost;
}

// =============================================================================
// Cache model
// =============================================================================

export type CacheGroupBy = "provider" | "model";

export interface CacheRow {
	key: string;
	label: string;
	totals: CacheTotals;
}

export interface HitSeries {
	key: string;
	label: string;
	/** Hit% per bucket; NaN where the series had no prompt input. */
	points: number[];
}

export interface CacheModel {
	totals: CacheTotals;
	/** Per-bucket totals aligned with plan.buckets. */
	buckets: CacheTotals[];
	/** Per provider/model, sorted by estCost desc. */
	rows: CacheRow[];
	/** Overall hit% first, then the top `hitSeriesCount` rows. */
	hitSeries: HitSeries[];
}

export const OVERALL_HIT_KEY = "\u0000all";

export function buildCacheModel(
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	plan: BucketPlan,
	rates: InputRates,
	options: { groupBy?: CacheGroupBy; hitSeriesCount?: number } = {}
): CacheModel {
	const groupBy = options.groupBy ?? "provider";
	const n = plan.buckets.length;
	const totals = emptyCacheTotals();
	const buckets = Array.from({ length: n }, () => emptyCacheTotals());
	const rowTotals = new Map<string, CacheTotals>();
	const rowBuckets = new Map<string, CacheTotals[]>();
	const rangeStart = plan.buckets[0]?.startMs ?? 0;
	const rangeEnd = plan.buckets[n - 1]?.endMs ?? 0;

	for (const [hour, bucket] of hourly) {
		if (hour < rangeStart || hour >= rangeEnd) continue;
		const idx = bucketIndexOf(plan.buckets, hour);
		if (idx < 0) continue;
		for (const [key, cell] of bucket) {
			const { provider, model } = splitHourlyKey(key);
			const k = rateKey(provider, model);
			const rate = rates.rates.get(k) ?? catalogInputRate(provider, model);
			const reports = rates.reporting.has(provider);
			addCell(totals, cell, rate, reports);
			addCell(buckets[idx]!, cell, rate, reports);
			const rk = groupBy === "provider" ? provider : model;
			let rt = rowTotals.get(rk);
			if (!rt) {
				rt = emptyCacheTotals();
				rowTotals.set(rk, rt);
				rowBuckets.set(
					rk,
					Array.from({ length: n }, () => emptyCacheTotals())
				);
			}
			addCell(rt, cell, rate, reports);
			addCell(rowBuckets.get(rk)![idx]!, cell, rate, reports);
		}
	}

	const rows: CacheRow[] = Array.from(rowTotals.entries())
		.filter(([, t]) => promptTokens(t) > 0 || t.unreportedPrompt > 0 || t.estCost > 0)
		.sort((a, b) => b[1].estCost - a[1].estCost || a[0].localeCompare(b[0]))
		.map(([key, t]) => ({ key, label: key, totals: t }));

	const hitSeries: HitSeries[] = [{ key: OVERALL_HIT_KEY, label: "All", points: buckets.map(hitPercent) }];
	const hitCount = Math.max(0, options.hitSeriesCount ?? 4);
	// Tools/summaries is a synthetic bucket of nested-agent usage; its hit rate
	// mixes many models and only adds noise to the per-provider lines.
	for (const row of rows.filter((r) => r.totals.cacheRead > 0 && r.key !== AUXILIARY_PROVIDER).slice(0, hitCount)) {
		hitSeries.push({ key: row.key, label: row.label, points: rowBuckets.get(row.key)!.map(hitPercent) });
	}

	return { totals, buckets, rows, hitSeries };
}

// =============================================================================
// Stacked composition charts (rendered with bars.ts)
// =============================================================================

export type CacheChart = "cost" | "tokens" | "misses";
export const CACHE_CHART_ORDER: CacheChart[] = ["cost", "tokens", "misses"];
export const CACHE_CHART_LABELS: Record<CacheChart, string> = {
	cost: "cost by token class",
	tokens: "prompt tokens: cached vs fresh",
	misses: "cache-miss cost by likely cause",
};

/** Fixed segment order (bottom → top) and labels per composition chart. */
export const CACHE_CHART_SERIES: Record<CacheChart, { key: string; label: string }[]> = {
	cost: [
		{ key: "cacheRead", label: "cache read" },
		{ key: "cacheWrite", label: "cache write" },
		{ key: "input", label: "uncached input" },
		{ key: "output", label: "output" },
		{ key: "unsplit", label: "unattributed" },
	],
	tokens: [
		{ key: "cacheRead", label: "cache read" },
		{ key: "cacheWrite", label: "cache write" },
		{ key: "input", label: "uncached input" },
	],
	misses: [
		{ key: "ttl", label: "idle >5m (TTL)" },
		{ key: "switch", label: "model switch" },
		{ key: "prefix", label: "prefix changed" },
	],
};

export function buildCacheStack(
	hourly: Map<number, Map<HourlyKey, HourlyCell>>,
	plan: BucketPlan,
	chart: CacheChart,
	context?: InputRates
): StackModel {
	return buildStack(
		hourly,
		plan,
		(key, cell, emit) => {
			switch (chart) {
				case "cost":
					emit("cacheRead", cell.costCacheRead);
					emit("cacheWrite", cell.costCacheWrite);
					emit("input", cell.costInput);
					emit("output", cell.costOutput);
					emit("unsplit", cell.costUnsplit);
					break;
				case "tokens": {
					// Models without cache reporting would show as all-uncached input.
					if (context) {
						if (!context.reporting.has(splitHourlyKey(key).provider)) break;
					}
					emit("cacheRead", cell.cacheRead);
					emit("cacheWrite", cell.cacheWrite);
					emit("input", cell.input);
					break;
				}
				case "misses":
					emit("ttl", cell.missTtlCost);
					emit("switch", cell.missSwitchCost);
					emit("prefix", cell.missPrefixCost);
					break;
			}
		},
		{ fixedOrder: CACHE_CHART_SERIES[chart] }
	);
}
