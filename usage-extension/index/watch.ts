/**
 * Filesystem watching for the live index: recursive fs.watch per root, debounced triggers and a periodic
 * safety sweep (fs.watch misses events on some filesystems / roots that appear later).
 * Must load under Node's native type stripping.
 */
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

export const WATCH_DEBOUNCE_MS = 750;
export const WATCH_SWEEP_MS = 60_000;

export interface UsageWatcherOptions {
	roots: string[];
	/** Called (never concurrently) after a debounce / sweep. */
	onTrigger: () => void | Promise<void>;
	debounceMs?: number;
	sweepMs?: number;
}

export class UsageWatcher {
	private readonly options: UsageWatcherOptions;
	private watchers = new Map<string, FSWatcher>();
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private sweep: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private rerun = false;
	private stopped = true;

	constructor(options: UsageWatcherOptions) {
		this.options = options;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attach();
		this.sweep = setInterval(() => {
			this.attach(); // roots that did not exist yet / watchers that errored
			this.fire();
		}, this.options.sweepMs ?? WATCH_SWEEP_MS);
		this.sweep.unref?.();
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

	private attach(): void {
		for (const root of this.options.roots) {
			if (this.watchers.has(root)) continue;
			try {
				const w = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
					const name = filename === null || filename === undefined ? "" : String(filename);
					if (name === "" || name.endsWith(".jsonl") || name.endsWith(".json")) this.schedule();
				});
				w.on("error", () => {
					w.close();
					if (this.watchers.get(root) === w) this.watchers.delete(root);
				});
				this.watchers.set(root, w);
			} catch {
				// Missing/unwatchable root: the sweep retries.
			}
		}
	}

	/** First event starts the timer; later events within the window coalesce (bounded latency). */
	private schedule(): void {
		if (this.stopped || this.debounce) return;
		this.debounce = setTimeout(() => {
			this.debounce = null;
			this.fire();
		}, this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
		this.debounce.unref?.();
	}

	private fire(): void {
		if (this.stopped) return;
		if (this.running) {
			this.rerun = true;
			return;
		}
		this.running = true;
		void Promise.resolve()
			.then(() => this.options.onTrigger())
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
