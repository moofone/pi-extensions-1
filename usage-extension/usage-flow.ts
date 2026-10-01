/**
 * /usage orchestration without pi imports (unit-testable with a fake UsageIndex).
 *
 * Flow: persisted rollup (instant native paint) → snapshot (loader only if slow) → dashboard →
 * live updates (subscribe → snapshot → updateDashboard) until closed.
 *
 * Loadable under Node's native type stripping (explicit .ts imports, no enums).
 */

import type { CollectProgress, UsageData } from "./data.ts";
import type { UsageIndex } from "./index/types.ts";
import { USAGE_NATIVE_KIND, USAGE_NATIVE_VERSION, buildUsageRollup, usageLoadingPayload, usageRefreshingPayload } from "./native.ts";
import type { UsageNativePayload, UsageRollup } from "./native.ts";

export const INITIAL_LOADING_MESSAGE = "Loading Usage...";
/** Show the loader only when the snapshot takes longer than this (avoids a flash on a fast refresh). */
export const LOADER_DELAY_MS = 150;

export interface UsageFlowClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: UsageFlowClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface UsageFlowCallbacks {
	/** The snapshot is slow: make the loader visible (TUI). `message` is the current message. */
	showLoading(message: string): void;
	/** Loader message changed (also called while the loader is not yet visible). */
	setLoadingMessage(message: string): void;
	/** First data: replace loader with the dashboard. */
	showDashboard(data: UsageData): void;
	/** Fresher data while the dashboard is open (keep UI state). */
	updateDashboard(data: UsageData): void;
	/** `surface()` now returns a new payload object (host should re-render / notify). */
	surfaceChanged(): void;
	/** The flow ended before a dashboard was shown (aborted / failed): close the UI. */
	end(): void;
}

export interface UsageFlowOptions {
	index: UsageIndex;
	callbacks: UsageFlowCallbacks;
	clock?: UsageFlowClock;
	loaderDelayMs?: number;
}

export interface UsageFlow {
	/** Resolves when the first snapshot has been shown (or the flow ended). Never rejects. */
	start(): Promise<void>;
	/** Current native payload (a new object whenever the content changes). */
	surface(): UsageNativePayload;
	/** Abort pending work, unsubscribe, ignore late results. Idempotent. */
	close(): void;
}

function formatSinceDate(ms: number, now: Date): string {
	const d = new Date(ms);
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
	if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

/** Loader text for a progress event, or null when nothing worth showing yet. */
export function progressMessage(p: CollectProgress, now: Date = new Date()): string | null {
	if (p.filesToParse === 0) return null;
	const files = `${p.filesParsed.toLocaleString()}/${p.filesToParse.toLocaleString()} files`;
	if (p.mode === "update") {
		const since = p.sinceMs !== null ? ` since ${formatSinceDate(p.sinceMs, now)}` : "";
		return `Updating your usage history${since}… (${files})`;
	}
	if (p.mode === "rebuild") return `Rebuilding your usage history — the cache format changed… (${files})`;
	return `Building your usage history for the first time… (${files})`;
}

/** Extract a usable rollup from whatever `lastRollup()` returned (a buildUsageRollup payload), else null. */
export function cachedRollupOf(value: unknown): UsageRollup | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { kind?: unknown; v?: unknown; rollup?: unknown };
	if (v.kind !== USAGE_NATIVE_KIND || v.v !== USAGE_NATIVE_VERSION) return null;
	const r = v.rollup as Partial<UsageRollup> | undefined;
	if (!r || typeof r !== "object" || !Array.isArray(r.days) || !Array.isArray(r.keys) || !Array.isArray(r.rows)) return null;
	return r as UsageRollup;
}

export function createUsageFlow(options: UsageFlowOptions): UsageFlow {
	const { index, callbacks } = options;
	const clock = options.clock ?? SYSTEM_CLOCK;
	const delay = options.loaderDelayMs ?? LOADER_DELAY_MS;
	const controller = new AbortController();

	let closed = false;
	let message = INITIAL_LOADING_MESSAGE;
	let cached: UsageRollup | null = null;
	let dashboardShown = false;
	let timer: unknown = null;
	let unsubscribe: (() => void) | null = null;
	let refreshing = false;
	let refreshAgain = false;

	let payload: UsageNativePayload = usageLoadingPayload(message);
	/** Dashboard data whose rollup is built lazily on the first surface() read (memoized per data). */
	let pendingData: UsageData | null = null;

	const loadingPayload = (): UsageNativePayload =>
		cached ? usageRefreshingPayload(cached, message) : usageLoadingPayload(message);

	const setPayload = (next: UsageNativePayload): void => {
		payload = next;
		pendingData = null;
		callbacks.surfaceChanged();
	};

	const setDataPayload = (data: UsageData): void => {
		pendingData = data;
		callbacks.surfaceChanged();
	};

	const setMessage = (next: string): void => {
		if (next === message || closed || dashboardShown) return;
		message = next;
		setPayload(loadingPayload());
		callbacks.setLoadingMessage(next);
	};

	const clearTimer = (): void => {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};

	const nowDate = (): Date => new Date(clock.now());

	const refresh = async (): Promise<void> => {
		if (refreshing) {
			refreshAgain = true;
			return;
		}
		refreshing = true;
		try {
			do {
				refreshAgain = false;
				let data: UsageData | null = null;
				try {
					data = await index.snapshot({ signal: controller.signal, now: nowDate() });
				} catch {
					data = null;
				}
				if (closed) return;
				// A newer change arrived while this snapshot ran: drop it, take a fresh one (latest wins).
				if (refreshAgain || !data) continue;
				callbacks.updateDashboard(data);
				setDataPayload(data);
			} while (refreshAgain && !closed);
		} finally {
			refreshing = false;
		}
	};

	const onChanged = (): void => {
		if (closed) return;
		if (!dashboardShown) {
			refreshAgain = true; // picked up right after the first dashboard
			return;
		}
		void refresh();
	};

	const start = async (): Promise<void> => {
		if (closed) return;
		timer = clock.setTimeout(() => {
			timer = null;
			if (closed || dashboardShown) return;
			callbacks.showLoading(message);
		}, delay);

		let last: unknown = null;
		try {
			last = await index.lastRollup();
		} catch {
			last = null;
		}
		if (closed) return;
		cached = cachedRollupOf(last);
		if (cached) setPayload(loadingPayload());

		unsubscribe = index.subscribe(onChanged);

		let data: UsageData | null = null;
		try {
			data = await index.snapshot({
				signal: controller.signal,
				now: nowDate(),
				onProgress: (p) => {
					const m = progressMessage(p, nowDate());
					if (m) setMessage(m);
				},
			});
		} catch {
			data = null;
		}
		clearTimer();
		if (closed) return;
		if (!data) {
			closed = true;
			unsubscribe?.();
			unsubscribe = null;
			callbacks.end();
			return;
		}
		dashboardShown = true;
		callbacks.showDashboard(data);
		setDataPayload(data);
		if (refreshAgain) {
			refreshAgain = false;
			void refresh();
		}
	};

	return {
		start,
		surface: () => {
			if (pendingData) {
				payload = buildUsageRollup(pendingData);
				pendingData = null;
			}
			return payload;
		},
		close() {
			if (closed) return;
			closed = true;
			clearTimer();
			controller.abort();
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}