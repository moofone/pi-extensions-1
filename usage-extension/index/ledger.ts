/**
 * Ledger: the incremental aggregate behind the usage snapshot.
 *
 * Every counted message is folded into fixed-width numeric vectors bucketed by QUARTER HOUR
 * (`Math.floor(ts / 900000)`), so local-midnight period boundaries (always multiples of 15 minutes in real
 * UTC offsets) are exact. Kept:
 *
 *  - global buckets   (quarter → provider/model/thinking cells + one raw-insight vector),
 *  - per-file buckets (same shape, per file) so a file's contribution is removed exactly (subtract),
 *  - a global `all` bucket for the all-time period.
 *
 * `snapshot(now)` never walks messages: it merges the quarter buckets inside each period window, uses the
 * per-file buckets of recently active files for session sets / totals.sessions / session+project costs,
 * rebuilds the hourly map from the quarters and runs `computeInsights`.
 *
 * Equivalence notes (collectUsageDataLegacy): totals.sessions counts FILES that contributed in a period (a
 * branched copy counts twice); per provider/model `sessions` are sets of session ids; sessionCosts is keyed
 * by session id, projectCosts by the file's project label. Messages without a timestamp (<= 0) only count
 * toward all-time (no hourly bucket, no trend), as in legacy. Period bounds are assumed to be multiples of
 * 15 minutes (true for every real local midnight since standardised time zones).
 */
import { computeInsights, CTX_LOW_THRESHOLD, CTX_TAX_THRESHOLD, DAY_MS, emptyModelStats, emptyPeriodRawData, emptyProviderStats, emptyUsageData, EXCLUDED_PROVIDERS, HOUR_MS, makeHourlyKey, TAB_ORDER } from "../data.ts";
import type { HourlyCell, MessageMeta, MissKind, PeriodBounds, PeriodRawData, SessionMessage, TabName, TrendInfo, UsageData } from "../data.ts";
import { freeTierUsd, splitCost } from "../sources.ts";
import type { ContributionDelta, CountedMessage, FileContribution, LedgerStats } from "./types.ts";

/** Local-calendar period starts for `now` (identical to collectUsageDataLegacy). */
export function periodBounds(now: Date): PeriodBounds {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const week = new Date(now);
	const dow = week.getDay();
	week.setDate(week.getDate() - (dow === 0 ? 6 : dow - 1));
	week.setHours(0, 0, 0, 0);
	const lastWeek = new Date(week);
	lastWeek.setDate(lastWeek.getDate() - 7);
	const last30 = new Date(today);
	last30.setDate(last30.getDate() - 29);
	return { todayMs: today.getTime(), weekStartMs: week.getTime(), lastWeekStartMs: lastWeek.getTime(), last30DaysStartMs: last30.getTime(), nowMs: now.getTime() };
}

const QUARTER_MS = 900_000;
const QUARTERS_PER_HOUR = HOUR_MS / QUARTER_MS;
/** Bucket id for messages without a usable timestamp (all-time only). */
const UNDATED = Number.MIN_SAFE_INTEGER;

// ---- cell vector layout (mirrors HourlyCell, plus n = contributing messages) ----
const C_MESSAGES = 0;
const C_COST = 1;
const C_EST = 2;
const C_INPUT = 3;
const C_OUTPUT = 4;
const C_CACHE_READ = 5;
const C_CACHE_WRITE = 6;
const C_REASONING = 7;
const C_CW1H = 8;
const C_COST_INPUT = 9;
const C_COST_OUTPUT = 10;
const C_COST_CR = 11;
const C_COST_CW = 12;
const C_COST_UNSPLIT = 13;
const C_MISS_TTL = 14;
const C_MISS_SWITCH = 15;
const C_MISS_PREFIX = 16;
const C_MISS_TTL_COST = 17;
const C_MISS_SWITCH_COST = 18;
const C_MISS_PREFIX_COST = 19;
const C_N = 20;
const CELL_LEN = 21;

// ---- raw (insight) vector layout ----
const R_TOTAL = 0;
const R_ASSISTANT = 1;
const R_AUX = 2;
const R_CTX_HIGH_COST = 3;
const R_CTX_HIGH_N = 4;
const R_CTX_LOW_COST = 5;
const R_CTX_LOW_N = 6;
const R_UPFRONT = 7;
const R_TTL = 8;
const R_SWITCH = 9;
const R_PREFIX = 10;
const R_REASONING = 11;
const R_OUTPUT = 12;
const R_CACHE_READ = 13;
const R_FRESH = 14;
const R_N = 15;
const RAW_LEN = 16;

/** Interned (provider, model) identity. */
interface PairInfo {
	provider: string;
	model: string;
}
/** Interned (provider, model, thinking) identity. */
interface KeyInfo {
	key: string;
	pair: PairInfo;
}
interface Cell {
	k: KeyInfo;
	v: Float64Array;
}
interface Bucket {
	cells: Map<string, Cell>;
	raw: Float64Array;
}
interface FileState {
	path: string;
	sessionId: string;
	project: string;
	buckets: Map<number, Bucket>;
	pairs: Set<PairInfo>;
	/** Counted (non-excluded) messages. */
	n: number;
	/** Sum of every counted message's cost. */
	cost: number;
	/** Highest dated quarter (−Infinity when none). */
	maxQ: number;
}

function newBucket(): Bucket {
	return { cells: new Map(), raw: new Float64Array(RAW_LEN) };
}

/** `a -= b`, snapping float residue to exact zero. */
function subVec(a: Float64Array, b: Float64Array): void {
	for (let i = 0; i < a.length; i++) {
		const x = a[i]! - b[i]!;
		const scale = Math.max(Math.abs(a[i]!), Math.abs(b[i]!));
		a[i] = Math.abs(x) < 1e-9 * scale ? 0 : x;
	}
}
function addVec(a: Float64Array, b: Float64Array): void {
	for (let i = 0; i < a.length; i++) a[i]! += b[i]!;
}

function addBucket(target: Bucket, src: Bucket): void {
	addVec(target.raw, src.raw);
	for (const [key, cell] of src.cells) {
		const t = target.cells.get(key);
		if (t) addVec(t.v, cell.v);
		else target.cells.set(key, { k: cell.k, v: cell.v.slice() });
	}
}

function subtractBucket(target: Bucket, src: Bucket): void {
	subVec(target.raw, src.raw);
	for (const [key, cell] of src.cells) {
		const t = target.cells.get(key);
		if (!t) continue;
		subVec(t.v, cell.v);
		if (t.v[C_N]! <= 0) target.cells.delete(key);
	}
}

function lowerBound(arr: number[], x: number): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid]! < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

const PERIOD_INDEX: Record<TabName, number> = { today: 0, thisWeek: 1, lastWeek: 2, last30Days: 3, allTime: 4 };

export class UsageLedger {
	private files = new Map<string, FileState>();
	private buckets = new Map<number, Bucket>();
	private all = newBucket();
	private sortedQ: number[] = [];
	private sortedDirty = false;
	private counted = 0;
	private keys = new Map<string, KeyInfo>();
	private pairs = new Map<string, PairInfo>();
	private readonly cellScratch = new Float64Array(CELL_LEN);
	private readonly rawScratch = new Float64Array(RAW_LEN);

	apply(delta: ContributionDelta): void {
		if (delta.reset) this.clear();
		for (const path of delta.removed) this.removeFile(path);
		for (const c of delta.replaced) {
			this.removeFile(c.path);
			this.addFile(c);
		}
		for (const a of delta.appended) {
			const f = this.files.get(a.path);
			if (f) this.addMessages(f, a.counted);
		}
	}

	stats(): LedgerStats {
		return { files: this.files.size, countedMessages: this.counted, buckets: this.buckets.size - (this.buckets.has(UNDATED) ? 1 : 0) };
	}

	// ---------------------------------------------------------------- mutation

	private clear(): void {
		this.files.clear();
		this.buckets.clear();
		this.all = newBucket();
		this.sortedQ = [];
		this.sortedDirty = false;
		this.counted = 0;
	}

	private addFile(c: FileContribution): void {
		const f: FileState = { path: c.path, sessionId: c.sessionId, project: c.project, buckets: new Map(), pairs: new Set(), n: 0, cost: 0, maxQ: -Infinity };
		this.files.set(c.path, f);
		this.addMessages(f, c.counted);
	}

	private removeFile(path: string): void {
		const f = this.files.get(path);
		if (!f) return;
		this.files.delete(path);
		for (const [q, fb] of f.buckets) {
			const gb = this.buckets.get(q);
			if (gb) {
				subtractBucket(gb, fb);
				if (gb.raw[R_N]! <= 0) {
					this.buckets.delete(q);
					if (q !== UNDATED) this.sortedDirty = true;
				}
			}
			subtractBucket(this.all, fb);
		}
		this.counted -= f.n;
	}

	private keyInfo(msg: SessionMessage): KeyInfo {
		const key = makeHourlyKey(msg.provider, msg.model, msg.thinkingLevel);
		let k = this.keys.get(key);
		if (!k) {
			const pk = msg.provider + "\u0000" + msg.model;
			let pair = this.pairs.get(pk);
			if (!pair) {
				pair = { provider: msg.provider, model: msg.model };
				this.pairs.set(pk, pair);
			}
			k = { key, pair };
			this.keys.set(key, k);
		}
		return k;
	}

	private globalBucket(q: number): Bucket {
		let b = this.buckets.get(q);
		if (!b) {
			b = newBucket();
			this.buckets.set(q, b);
			if (q !== UNDATED && !this.sortedDirty) {
				const last = this.sortedQ[this.sortedQ.length - 1];
				if (last === undefined || q > last) this.sortedQ.push(q);
				else this.sortedDirty = true;
			}
		}
		return b;
	}

	private addMessages(f: FileState, counted: CountedMessage[]): void {
		const cv = this.cellScratch;
		const rv = this.rawScratch;
		for (const { msg, meta, miss } of counted) {
			if (EXCLUDED_PROVIDERS.has(msg.provider)) continue;
			const info = this.keyInfo(msg);
			fillVectors(cv, rv, msg, meta, miss);
			const dated = msg.timestamp > 0;
			const q = dated ? Math.floor(msg.timestamp / QUARTER_MS) : UNDATED;
			for (const bucket of [f.buckets.get(q) ?? this.fileBucket(f, q), this.globalBucket(q), this.all]) {
				addVec(bucket.raw, rv);
				const t = bucket.cells.get(info.key);
				if (t) addVec(t.v, cv);
				else bucket.cells.set(info.key, { k: info, v: cv.slice() });
			}
			f.pairs.add(info.pair);
			f.n++;
			f.cost += msg.cost;
			if (dated && q > f.maxQ) f.maxQ = q;
			this.counted++;
		}
	}

	private fileBucket(f: FileState, q: number): Bucket {
		const b = newBucket();
		f.buckets.set(q, b);
		return b;
	}

	// ---------------------------------------------------------------- snapshot

	snapshot(now: Date): UsageData {
		const b = periodBounds(now);
		const data = emptyUsageData(b);
		const raw = Object.fromEntries(TAB_ORDER.map((t) => [t, emptyPeriodRawData()])) as Record<TabName, PeriodRawData>;
		if (this.sortedDirty) {
			this.sortedQ = [...this.buckets.keys()].filter((q) => q !== UNDATED).sort((x, y) => x - y);
			this.sortedDirty = false;
		}
		const sorted = this.sortedQ;

		const qt = Math.ceil(b.todayMs / QUARTER_MS);
		const qw = Math.ceil(b.weekStartMs / QUARTER_MS);
		const qlw = Math.ceil(b.lastWeekStartMs / QUARTER_MS);
		const ql30 = Math.ceil(b.last30DaysStartMs / QUARTER_MS);
		const qMin = Math.min(qt, qw, qlw, ql30);
		/** Bit i set ⇔ quarter q belongs to TAB_ORDER[i] (allTime, bit 4, handled separately). */
		const maskOf = (q: number): number => (q >= qt ? 1 : 0) | (q >= qw ? 2 : 0) | (q >= qlw && q < qw ? 4 : 0) | (q >= ql30 ? 8 : 0);

		// --- Sums: cells + raw vectors per period.
		const cellAcc: Array<Map<PairInfo, Float64Array>> = [new Map(), new Map(), new Map(), new Map(), new Map()];
		const rawAcc = [0, 1, 2, 3, 4].map(() => new Float64Array(RAW_LEN));
		for (let i = lowerBound(sorted, qMin); i < sorted.length; i++) {
			const q = sorted[i]!;
			const mask = maskOf(q);
			if (mask === 0) continue;
			const bucket = this.buckets.get(q)!;
			for (let p = 0; p < 4; p++) {
				if (!(mask & (1 << p))) continue;
				addVec(rawAcc[p]!, bucket.raw);
				mergeCells(cellAcc[p]!, bucket);
			}
		}
		addVec(rawAcc[4]!, this.all.raw);
		mergeCells(cellAcc[4]!, this.all);

		for (const period of TAB_ORDER) {
			const pi = PERIOD_INDEX[period];
			const stats = data[period];
			for (const [pair, v] of cellAcc[pi]!) {
				let ps = stats.providers.get(pair.provider);
				if (!ps) {
					ps = emptyProviderStats();
					stats.providers.set(pair.provider, ps);
				}
				let ms = ps.models.get(pair.model);
				if (!ms) {
					ms = emptyModelStats();
					ps.models.set(pair.model, ms);
				}
				for (const s of [ms, ps, stats.totals]) {
					s.messages += v[C_MESSAGES]!;
					s.cost += v[C_COST]!;
					s.estCost += v[C_EST]!;
					s.tokens.total += v[C_INPUT]! + v[C_OUTPUT]! + v[C_CACHE_WRITE]!;
					s.tokens.input += v[C_INPUT]!;
					s.tokens.output += v[C_OUTPUT]!;
					s.tokens.cacheRead += v[C_CACHE_READ]!;
					s.tokens.cacheWrite += v[C_CACHE_WRITE]!;
				}
			}
			fillRaw(raw[period], rawAcc[pi]!);
		}

		// --- Sessions, per-file costs.
		const windowSets: Array<Set<PairInfo>> = [new Set(), new Set(), new Set(), new Set()];
		const windowCost = [0, 0, 0, 0];
		const windowPresent = [false, false, false, false];
		for (const f of this.files.values()) {
			if (f.n === 0) continue;
			// All-time.
			data.allTime.totals.sessions++;
			addTo(raw.allTime.sessionCosts, f.sessionId, f.cost);
			addTo(raw.allTime.projectCosts, f.project, f.cost);
			for (const pair of f.pairs) markSession(data.allTime, pair, f.sessionId);
			if (f.maxQ < qMin) continue;
			// Windowed periods.
			for (let p = 0; p < 4; p++) {
				windowSets[p]!.clear();
				windowCost[p] = 0;
				windowPresent[p] = false;
			}
			for (const [q, fb] of f.buckets) {
				if (q < qMin) continue;
				const mask = maskOf(q);
				if (mask === 0) continue;
				for (let p = 0; p < 4; p++) {
					if (!(mask & (1 << p))) continue;
					windowPresent[p] = true;
					windowCost[p]! += fb.raw[R_TOTAL]!;
					for (const cell of fb.cells.values()) windowSets[p]!.add(cell.k.pair);
				}
			}
			for (let p = 0; p < 4; p++) {
				if (!windowPresent[p]) continue;
				const period = TAB_ORDER[p]!;
				data[period].totals.sessions++;
				addTo(raw[period].sessionCosts, f.sessionId, windowCost[p]!);
				addTo(raw[period].projectCosts, f.project, windowCost[p]!);
				for (const pair of windowSets[p]!) markSession(data[period], pair, f.sessionId);
			}
		}

		// --- Hourly map (UTC hour = four quarters).
		let curHour = Number.NaN;
		let cur: Map<string, { k: KeyInfo; v: Float64Array }> | null = null;
		const flush = (): void => {
			if (!cur) return;
			const bucket = new Map<string, HourlyCell>();
			for (const [key, c] of cur) bucket.set(key, toHourlyCell(c.v));
			data.hourly.set(curHour * HOUR_MS, bucket);
		};
		for (const q of sorted) {
			const hour = Math.floor(q / QUARTERS_PER_HOUR);
			if (hour !== curHour) {
				flush();
				curHour = hour;
				cur = new Map();
			}
			for (const [key, cell] of this.buckets.get(q)!.cells) {
				const t = cur!.get(key);
				if (t) addVec(t.v, cell.v);
				else cur!.set(key, { k: cell.k, v: cell.v.slice() });
			}
		}
		flush();

		// --- Burn trend (day index relative to local midnight, as legacy).
		let last7 = 0;
		let prior28 = 0;
		for (let i = lowerBound(sorted, Math.ceil((b.todayMs - 34 * DAY_MS) / QUARTER_MS)); i < sorted.length; i++) {
			const q = sorted[i]!;
			const idx = Math.floor((q * QUARTER_MS - b.todayMs) / DAY_MS);
			const cost = this.buckets.get(q)!.raw[R_TOTAL]!;
			if (idx >= -6) last7 += cost;
			else if (idx >= -34) prior28 += cost;
		}
		const trend: TrendInfo | null = prior28 > 0 ? { last7Cost: last7, priorWeeklyPace: prior28 / 4 } : null;
		for (const period of TAB_ORDER) data[period].insights = computeInsights(raw[period], trend);
		return data;
	}
}

function addTo(map: Map<string, number>, key: string, value: number): void {
	map.set(key, (map.get(key) ?? 0) + value);
}

function markSession(stats: UsageData["allTime"], pair: PairInfo, sessionId: string): void {
	const ps = stats.providers.get(pair.provider);
	if (!ps) return;
	ps.sessions.add(sessionId);
	ps.models.get(pair.model)?.sessions.add(sessionId);
}

function mergeCells(acc: Map<PairInfo, Float64Array>, bucket: Bucket): void {
	for (const cell of bucket.cells.values()) {
		const t = acc.get(cell.k.pair);
		if (t) addVec(t, cell.v);
		else acc.set(cell.k.pair, cell.v.slice());
	}
}

function fillRaw(raw: PeriodRawData, v: Float64Array): void {
	raw.totalCost = v[R_TOTAL]!;
	raw.assistantCost = v[R_ASSISTANT]!;
	raw.auxiliaryCost = v[R_AUX]!;
	raw.ctxHigh = { cost: v[R_CTX_HIGH_COST]!, messages: v[R_CTX_HIGH_N]! };
	raw.ctxLow = { cost: v[R_CTX_LOW_COST]!, messages: v[R_CTX_LOW_N]! };
	raw.upfrontCost = v[R_UPFRONT]!;
	raw.ttlMissCost = v[R_TTL]!;
	raw.modelSwitchMissCost = v[R_SWITCH]!;
	raw.prefixMissCost = v[R_PREFIX]!;
	raw.reasoningTokens = v[R_REASONING]!;
	raw.outputTokens = v[R_OUTPUT]!;
	raw.cacheReadTokens = v[R_CACHE_READ]!;
	raw.freshTokens = v[R_FRESH]!;
}

function toHourlyCell(v: Float64Array): HourlyCell {
	return {
		messages: v[C_MESSAGES]!,
		cost: v[C_COST]!,
		estCost: v[C_EST]!,
		input: v[C_INPUT]!,
		output: v[C_OUTPUT]!,
		cacheRead: v[C_CACHE_READ]!,
		cacheWrite: v[C_CACHE_WRITE]!,
		reasoning: v[C_REASONING]!,
		cacheWrite1h: v[C_CW1H]!,
		costInput: v[C_COST_INPUT]!,
		costOutput: v[C_COST_OUTPUT]!,
		costCacheRead: v[C_COST_CR]!,
		costCacheWrite: v[C_COST_CW]!,
		costUnsplit: v[C_COST_UNSPLIT]!,
		missTtl: v[C_MISS_TTL]!,
		missSwitch: v[C_MISS_SWITCH]!,
		missPrefix: v[C_MISS_PREFIX]!,
		missTtlCost: v[C_MISS_TTL_COST]!,
		missSwitchCost: v[C_MISS_SWITCH_COST]!,
		missPrefixCost: v[C_MISS_PREFIX_COST]!,
	};
}

/** One message's contribution to a cell vector and a raw vector (legacy addMessagesToUsageData rules). */
function fillVectors(cv: Float64Array, rv: Float64Array, msg: SessionMessage, meta: MessageMeta, miss: MissKind | null): void {
	cv.fill(0);
	rv.fill(0);
	const isAssistant = msg.source === "assistant";
	const est = freeTierUsd(msg.provider, msg.model, msg);
	cv[C_MESSAGES] = isAssistant ? 1 : 0;
	cv[C_COST] = msg.cost;
	cv[C_EST] = est;
	cv[C_INPUT] = msg.input;
	cv[C_OUTPUT] = msg.output;
	cv[C_CACHE_READ] = msg.cacheRead;
	cv[C_CACHE_WRITE] = msg.cacheWrite;
	cv[C_REASONING] = msg.reasoning;
	cv[C_CW1H] = msg.cacheWrite1h ?? 0;
	const parts = splitCost(msg.provider, msg.model, msg, est, {
		input: msg.costInput ?? 0,
		output: msg.costOutput ?? 0,
		cacheRead: msg.costCacheRead ?? 0,
		cacheWrite: msg.costCacheWrite ?? 0,
	});
	cv[C_COST_INPUT] = parts.input;
	cv[C_COST_OUTPUT] = parts.output;
	cv[C_COST_CR] = parts.cacheRead;
	cv[C_COST_CW] = parts.cacheWrite;
	cv[C_COST_UNSPLIT] = parts.unsplit;
	cv[C_N] = 1;
	if (miss === "ttl") {
		cv[C_MISS_TTL] = 1;
		cv[C_MISS_TTL_COST] = msg.cost;
	} else if (miss === "switch") {
		cv[C_MISS_SWITCH] = 1;
		cv[C_MISS_SWITCH_COST] = msg.cost;
	} else if (miss === "prefix") {
		cv[C_MISS_PREFIX] = 1;
		cv[C_MISS_PREFIX_COST] = msg.cost;
	}

	rv[R_N] = 1;
	rv[R_TOTAL] = msg.cost;
	if (!isAssistant) {
		rv[R_AUX] = msg.cost;
		return;
	}
	rv[R_ASSISTANT] = msg.cost;
	const ctx = msg.input + msg.cacheRead + msg.cacheWrite;
	if (ctx >= CTX_TAX_THRESHOLD) {
		rv[R_CTX_HIGH_COST] = msg.cost;
		rv[R_CTX_HIGH_N] = 1;
	} else if (ctx < CTX_LOW_THRESHOLD) {
		rv[R_CTX_LOW_COST] = msg.cost;
		rv[R_CTX_LOW_N] = 1;
	}
	if (meta.isSessionStart) rv[R_UPFRONT] = msg.cost;
	if (miss === "ttl") rv[R_TTL] = msg.cost;
	else if (miss === "switch") rv[R_SWITCH] = msg.cost;
	else if (miss === "prefix") rv[R_PREFIX] = msg.cost;
	rv[R_REASONING] = msg.reasoning;
	rv[R_OUTPUT] = msg.output;
	rv[R_CACHE_READ] = msg.cacheRead;
	rv[R_FRESH] = msg.input + msg.cacheWrite;
}
