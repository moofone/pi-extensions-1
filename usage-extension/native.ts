/**
 * Native-client payload for /usage.
 *
 * Native hosts (pi-hud) read `component.surfaceData` on the ctx.ui.custom()
 * components and render their own dashboard from this daily rollup. The TUI
 * path never touches this module.
 *
 * Wire format: kind "pi-hud/usage", v 1 — see UsageNativePayload.
 */

import { buildInputRates } from "./cache.ts";
import { splitHourlyKey } from "./data.ts";
import type { UsageData } from "./data.ts";

export const USAGE_NATIVE_KIND = "pi-hud/usage";
export const USAGE_NATIVE_VERSION = 1;

/** Column order of every rollup row after [dayIndex, keyIndex]. */
export const ROLLUP_FIELDS = [
	"cost",
	"tokens",
	"msgs",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cacheWrite1h",
	"cIn",
	"cOut",
	"cCR",
	"cCW",
	"cUn",
	"mTtl",
	"mSw",
	"mPre",
	"mTtlC",
	"saved",
	"billed",
	"mSwC",
	"mPreC",
] as const;

/** Fields that are USD amounts (rounded to 1e-6); all others are integer counts. */
const MONEY = new Set<string>([
	"cost",
	"cIn",
	"cOut",
	"cCR",
	"cCW",
	"cUn",
	"mTtlC",
	"saved",
	"billed",
	"mSwC",
	"mPreC",
]);
const IS_MONEY = ROLLUP_FIELDS.map((f) => MONEY.has(f));
const N = ROLLUP_FIELDS.length;

export interface UsageRollup {
	generatedAt: string;
	days: string[];
	keys: Array<[string, string]>;
	reporting: string[];
	fields: string[];
	rows: number[][];
}

export interface UsageNativeRollupPayload {
	kind: typeof USAGE_NATIVE_KIND;
	v: typeof USAGE_NATIVE_VERSION;
	rollup: UsageRollup;
}

export interface UsageNativeLoadingPayload {
	kind: typeof USAGE_NATIVE_KIND;
	v: typeof USAGE_NATIVE_VERSION;
	loading: { message: string };
}

export type UsageNativePayload = UsageNativeRollupPayload | UsageNativeLoadingPayload;

export function usageLoadingPayload(message: string): UsageNativeLoadingPayload {
	return { kind: USAGE_NATIVE_KIND, v: USAGE_NATIVE_VERSION, loading: { message } };
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function localDayKey(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function round6(v: number): number {
	return Math.round(v * 1e6) / 1e6;
}

export function buildUsageRollup(data: UsageData, options: { now?: Date } = {}): UsageNativeRollupPayload {
	const nowMs = options.now ? options.now.getTime() : data.bounds.nowMs;
	const rates = buildInputRates(data.hourly);

	// Contiguous local days: first bucket's day .. today.
	let firstMs = Infinity;
	for (const hour of data.hourly.keys()) if (hour < firstMs) firstMs = hour;
	const today = new Date(nowMs);
	const start = new Date(Number.isFinite(firstMs) && firstMs < nowMs ? firstMs : nowMs);
	const days: string[] = [];
	const dayIndex = new Map<string, number>();
	for (
		let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
		localDayKey(d) <= localDayKey(today);
		d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
	) {
		const k = localDayKey(d);
		dayIndex.set(k, days.length);
		days.push(k);
	}
	const lastDay = days.length - 1;

	const keys: Array<[string, string]> = [];
	const keyIndex = new Map<string, number>();
	const acc = new Map<number, Float64Array>(); // dayIdx * 1e6 + keyIdx -> sums
	const hourDay = new Map<number, number>();

	for (const [hour, bucket] of data.hourly) {
		let di = hourDay.get(hour);
		if (di === undefined) {
			di = dayIndex.get(localDayKey(new Date(hour))) ?? lastDay;
			hourDay.set(hour, di);
		}
		for (const [hk, cell] of bucket) {
			const { provider, model } = splitHourlyKey(hk);
			if (provider === "mock") continue;
			const kk = provider + "\u0000" + model;
			let ki = keyIndex.get(kk);
			if (ki === undefined) {
				ki = keys.length;
				keyIndex.set(kk, ki);
				keys.push([provider, model]);
			}
			const rate = rates.rates.get(kk) ?? 0;
			const saved =
				rate > 0 ? cell.cacheRead * rate - cell.costCacheRead - (cell.costCacheWrite - cell.cacheWrite * rate) : 0;
			const slot = di * 1_000_000 + ki;
			let a = acc.get(slot);
			if (!a) {
				a = new Float64Array(N);
				acc.set(slot, a);
			}
			a[0]! += cell.estCost;
			a[1]! += cell.input + cell.output + cell.cacheWrite;
			a[2]! += cell.messages;
			a[3]! += cell.input;
			a[4]! += cell.output;
			a[5]! += cell.cacheRead;
			a[6]! += cell.cacheWrite;
			a[7]! += cell.cacheWrite1h;
			a[8]! += cell.costInput;
			a[9]! += cell.costOutput;
			a[10]! += cell.costCacheRead;
			a[11]! += cell.costCacheWrite;
			a[12]! += cell.costUnsplit;
			a[13]! += cell.missTtl;
			a[14]! += cell.missSwitch;
			a[15]! += cell.missPrefix;
			a[16]! += cell.missTtlCost;
			a[17]! += saved;
			a[18]! += cell.cost;
			a[19]! += cell.missSwitchCost;
			a[20]! += cell.missPrefixCost;
		}
	}

	const rows: number[][] = [];
	const slots = Array.from(acc.keys()).sort((x, y) => x - y);
	for (const slot of slots) {
		const a = acc.get(slot)!;
		const row: number[] = [Math.floor(slot / 1_000_000), slot % 1_000_000];
		let nonZero = false;
		for (let i = 0; i < N; i++) {
			const v = IS_MONEY[i] ? round6(a[i]!) : Math.round(a[i]!);
			if (v !== 0) nonZero = true;
			row.push(v === 0 ? 0 : v); // normalise -0
		}
		if (nonZero) rows.push(row);
	}

	return {
		kind: USAGE_NATIVE_KIND,
		v: USAGE_NATIVE_VERSION,
		rollup: {
			generatedAt: new Date(nowMs).toISOString(),
			days,
			keys,
			reporting: Array.from(rates.reporting).filter((p) => p !== "mock"),
			fields: [...ROLLUP_FIELDS],
			rows,
		},
	};
}

/** Attach a `surfaceData` accessor (function form) to a component. */
export function withSurfaceData<T extends object>(component: T, get: () => UsageNativePayload | undefined): T {
	(component as { surfaceData?: () => UsageNativePayload | undefined }).surfaceData = get;
	return component;
}

/** Memoized lazy payload getter: builds once, returns the same reference thereafter. */
export function lazyRollup(data: UsageData): () => UsageNativePayload {
	let payload: UsageNativePayload | undefined;
	return () => (payload ??= buildUsageRollup(data));
}

/** Loading-phase state: payload object is replaced only when the message changes. */
export function loadingSurface(initial: string): { set(message: string): void; get(): UsageNativePayload } {
	let message = initial;
	let payload = usageLoadingPayload(message);
	return {
		set(next: string) {
			if (next === message) return;
			message = next;
			payload = usageLoadingPayload(message);
		},
		get: () => payload,
	};
}
