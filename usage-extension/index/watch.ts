/**
 * Filesystem watching for the live index: recursive fs.watch per root. Two jobs:
 *   1. dirty tracking — every event reports the touched path (`onEvent`), watcher errors report `onError`,
 *      so the core can refresh by stat'ing only dirty paths instead of rediscovering everything;
 *   2. background refresh — while a trigger is set, events (debounced) and a periodic safety sweep call it.
 * Must load under Node's native type stripping.
 */
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

export const WATCH_DEBOUNCE_MS = 750;
export const WATCH_SWEEP_MS = 60_000;

export interface UsageWatcherOptions {
	roots: string[];
	/** Every fs event: the absolute path, or null when the platform gave no file name. */
	onEvent?: (path: string | null, root: string) => void;
	/** A watcher failed (overflow, root removed, …): events may have been lost. */
	onError?: (root: string) => void;
	/** Background refresh trigger (debounced); can also be set later with `setTrigger`. */
	onTrigger?: () => void | Promise<void>;
	debounceMs?: number;
	sweepMs?: number;
}

export class UsageWatcher {
	private readonly options: UsageWatcherOptions;
	private trigger: (() => void | Promise<void>) | null;
	private watchers = new Map<string, FSWatcher>();
	/** Roots that do not exist (yet): they hold no files, so they do not make the watch unhealthy. */
	private missing = new Set<string>();
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private sweep: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private rerun = false;
	private stopped = true;

	constructor(options: UsageWatcherOptions) {
		this.options = options;
		this.trigger = options.onTrigger ?? null;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attach();
		this.armSweep();
	}

	stop(): void {
		this.stopped = true;
		if (this.debounce) clearTimeout(this.debounce);
		if (this.sweep) clearInterval(this.sweep);
		this.debounce = null;
		this.sweep = null;
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
	}

	/** Set (or clear with null) the background refresh trigger. */
	setTrigger(trigger: (() => void | Promise<void>) | null): void {
		this.trigger = trigger;
		if (!trigger && this.debounce) {
			clearTimeout(this.debounce);
			this.debounce = null;
		}
		this.armSweep();
	}

	/** Every existing root has a live fs watcher, i.e. no event can have been missed because of a missing
	 * watch. (A root that appears later is picked up by the periodic full sweep.) */
	get healthy(): boolean {
		return !this.stopped && this.options.roots.every((root) => this.watchers.has(root) || this.missing.has(root));
	}

	/** (Re)attach watchers for roots that have none (not there yet, or errored). */
	attach(): void {
		if (this.stopped) return;
		for (const root of this.options.roots) {
			if (this.watchers.has(root)) continue;
			this.missing.delete(root);
			try {
				const w = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
					const name = filename === null || filename === undefined ? "" : String(filename);
					this.options.onEvent?.(name === "" ? null : join(root, name), root);
					if (name === "" || name.endsWith(".jsonl") || name.endsWith(".json")) this.schedule();
				});
				w.on("error", () => {
					w.close();
					if (this.watchers.get(root) === w) this.watchers.delete(root);
					this.options.onError?.(root);
				});
				this.watchers.set(root, w);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// Missing root: nothing to watch. Anything else: `healthy` stays false; the next attach retries.
				if (code === "ENOENT" || code === "ENOTDIR") this.missing.add(root);
			}
		}
	}

	private armSweep(): void {
		if (this.stopped) return;
		if (this.trigger && !this.sweep) {
			this.sweep = setInterval(() => {
				this.attach();
				this.fire();
			}, this.options.sweepMs ?? WATCH_SWEEP_MS);
			this.sweep.unref?.();
		} else if (!this.trigger && this.sweep) {
			clearInterval(this.sweep);
			this.sweep = null;
		}
	}

	/** First event starts the timer; later events within the window coalesce (bounded latency). */
	private schedule(): void {
		if (this.stopped || !this.trigger || this.debounce) return;
		this.debounce = setTimeout(() => {
			this.debounce = null;
			this.fire();
		}, this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
		this.debounce.unref?.();
	}

	private fire(): void {
		const trigger = this.trigger;
		if (this.stopped || !trigger) return;
		if (this.running) {
			this.rerun = true;
			return;
		}
		this.running = true;
		void Promise.resolve()
			.then(() => trigger())
			.catch(() => {})
			.finally(() => {
				this.running = false;
				if (this.rerun && !this.stopped) {
					this.rerun = false;
					this.fire();
				}
			});
	}
}
