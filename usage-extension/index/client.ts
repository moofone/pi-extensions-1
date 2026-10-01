/**
 * Process-wide usage index handle. The core (service.ts) runs in a worker thread (worker.ts) so the host's
 * main thread never does the heavy work; if a Worker cannot start, or crashes twice, the very same core
 * runs in-thread. `lastRollup()` reads the persisted rollup directly (no worker start).
 *
 *   getUsageIndex(options) → one instance per option key, stored on globalThis[Symbol.for("pi-usage-index")]
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { getAgentDir } from "../data.ts";
import type { UsageData } from "../data.ts";
import type { IndexProgress, SnapshotOptions, UsageIndex, UsageIndexOptions } from "./types.ts";

const REGISTRY = Symbol.for("pi-usage-index");
type Registry = Map<string, UsageIndex>;

export const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const DISPOSE_TIMEOUT_MS = 10_000;

/** Client-only extras (tests): a different worker entry script. */
export interface UsageIndexClientOptions extends UsageIndexOptions {
	workerEntry?: URL | string;
}

function registry(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (g[REGISTRY] ??= new Map());
}

function optionKey(o: UsageIndexClientOptions): string {
	return JSON.stringify([o.agentDir, o.sessionsDir, o.sources, o.storeDir, o.legacyCachePath, o.worker, o.parseWorkers, o.watch, String(o.workerEntry ?? "")]);
}

interface PendingSnapshot {
	id: number;
	nowMs: number;
	controller: AbortController;
	onProgress?: (progress: IndexProgress) => void;
	resolve: (data: UsageData | null) => void;
	reject: (error: Error) => void;
}

type CoreLike = import("./service.ts").UsageIndexCore;

class ClientIndex implements UsageIndex {
	private readonly key: string;
	private readonly options: UsageIndexClientOptions;
	private readonly idleTtlMs: number;
	private worker: Worker | null = null;
	private workerReady = false;
	private core: CoreLike | null = null;
	private corePromise: Promise<CoreLike> | null = null;
	private forcedInThread: boolean;
	private crashes = 0;
	private nextId = 1;
	private pending = new Map<number, PendingSnapshot>();
	private waiters = new Map<number, () => void>();
	private listeners = new Set<() => void>();
	private busy = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(key: string, options: UsageIndexClientOptions) {
		this.key = key;
		this.options = options;
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.forcedInThread = options.worker === false;
	}

	/** Diagnostics for tests/tools. */
	debugState(): { worker: boolean; inThread: boolean; forcedInThread: boolean; crashes: number; subscribers: number } {
		return { worker: this.worker !== null, inThread: this.core !== null, forcedInThread: this.forcedInThread, crashes: this.crashes, subscribers: this.listeners.size };
	}

	// --- public API ---------------------------------------------------------------------------------------

	async lastRollup(): Promise<unknown | null> {
		const storeDir = this.options.storeDir === undefined ? join(this.options.agentDir ?? getAgentDir(), "usage-index") : this.options.storeDir;
		if (storeDir) {
			try {
				return JSON.parse(await readFile(join(storeDir, "rollup.json"), "utf8")) as unknown;
			} catch {
				// No (readable) rollup file yet.
			}
		}
		return this.core ? this.core.lastRollup() : null;
	}

	async snapshot(options: SnapshotOptions = {}): Promise<UsageData | null> {
		if (this.disposed) return null;
		const { signal } = options;
		if (signal?.aborted) return null;
		this.begin();
		try {
			if (!this.forcedInThread && this.ensureWorker()) {
				return await new Promise<UsageData | null>((resolve, reject) => {
					const controller = new AbortController();
					const entry: PendingSnapshot = { id: this.nextId++, nowMs: (options.now ?? new Date()).getTime(), controller, onProgress: options.onProgress, resolve, reject };
					this.pending.set(entry.id, entry);
					const abort = () => {
						controller.abort();
						this.worker?.postMessage({ type: "abort", id: entry.id });
					};
					signal?.addEventListener("abort", abort, { once: true });
					entry.resolve = (data) => {
						signal?.removeEventListener("abort", abort);
						resolve(data);
					};
					entry.reject = (error) => {
						signal?.removeEventListener("abort", abort);
						reject(error);
					};
					this.worker!.postMessage({ type: "snapshot", id: entry.id, nowMs: entry.nowMs });
				});
			}
			return await (await this.inThreadCore()).snapshot(options);
		} finally {
			this.end();
		}
	}

	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		if (this.listeners.size === 1) this.syncWatch();
		this.touchIdle();
		return () => {
			if (!this.listeners.delete(listener)) return;
			if (this.listeners.size === 0) this.syncWatch();
			this.touchIdle();
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const reg = registry();
		if (reg.get(this.key) === this) reg.delete(this.key);
		this.listeners.clear();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const entry of this.pending.values()) entry.resolve(null);
		this.pending.clear();
		await this.shutdown();
	}

	// --- idle handling ------------------------------------------------------------------------------------

	private begin(): void {
		this.busy++;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private end(): void {
		this.busy--;
		this.touchIdle();
	}

	private touchIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (this.disposed || this.busy > 0 || this.listeners.size > 0) return;
		if (!this.worker && !this.core) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.busy === 0 && this.listeners.size === 0) void this.shutdown();
		}, this.idleTtlMs);
		this.idleTimer.unref?.();
	}

	/** Flush the store and release the worker / in-thread core (they restart lazily on the next call). */
	private async shutdown(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		this.workerReady = false;
		if (worker) {
			const id = this.nextId++;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
				timer.unref?.();
				this.waiters.set(id, () => {
					clearTimeout(timer);
					resolve();
				});
				worker.once("exit", () => resolve());
				try {
					worker.postMessage({ type: "dispose", id });
				} catch {
					resolve();
				}
			});
			this.waiters.delete(id);
			await worker.terminate().catch(() => {});
		}
		const core = this.core ?? (this.corePromise ? await this.corePromise.catch(() => null) : null);
		this.core = null;
		this.corePromise = null;
		if (core) await core.dispose();
	}

	// --- worker host --------------------------------------------------------------------------------------

	/** Start the worker if needed. False → run in-thread. */
	private ensureWorker(): boolean {
		if (this.worker) return true;
		if (this.forcedInThread) return false;
		let worker: Worker;
		try {
			worker = new Worker(this.options.workerEntry ?? new URL("./worker.ts", import.meta.url), {
				workerData: { role: "index", options: this.cloneableOptions() },
				// Keep worker stdio (module-type warnings, stray logs) off the host's terminal.
				stdout: true,
				stderr: true,
			});
			worker.stdout.resume();
			worker.stderr.resume();
		} catch {
			this.forcedInThread = true;
			return false;
		}
		worker.unref();
		this.worker = worker;
		this.workerReady = false;
		worker.on("message", (message: WorkerMessage) => this.onMessage(worker, message));
		worker.on("error", () => this.onGone(worker));
		worker.on("exit", () => this.onGone(worker));
		if (this.listeners.size > 0) worker.postMessage({ type: "watch", on: true });
		return true;
	}

	private cloneableOptions(): UsageIndexOptions {
		const { workerEntry: _entry, ...rest } = this.options;
		return rest;
	}

	private onMessage(worker: Worker, message: WorkerMessage): void {
		if (message.type === "disposed" || message.type === "flushed") {
			this.waiters.get(message.id)?.();
			return;
		}
		if (worker !== this.worker) return;
		switch (message.type) {
			case "ready":
				this.workerReady = true;
				break;
			case "progress":
				this.pending.get(message.id)?.onProgress?.(message.progress);
				break;
			case "result": {
				const entry = this.pending.get(message.id);
				this.pending.delete(message.id);
				entry?.resolve(message.data);
				break;
			}
			case "error": {
				const entry = this.pending.get(message.id);
				this.pending.delete(message.id);
				entry?.reject(new Error(message.message));
				break;
			}
			case "changed":
				for (const listener of [...this.listeners]) {
					try {
						listener();
					} catch {
						// A bad listener must not break the others.
					}
				}
				break;
		}
	}

	/** The worker died (crash, failed start) or was terminated. Unexpected deaths are retried once. */
	private onGone(worker: Worker): void {
		if (worker !== this.worker) return; // intentional shutdown / stale
		this.worker = null;
		const neverStarted = !this.workerReady;
		this.workerReady = false;
		this.crashes++;
		if (neverStarted || this.crashes >= 2) this.forcedInThread = true;
		if (this.disposed) return;
		const entries = [...this.pending.values()];
		if (this.forcedInThread) {
			// Run what was in flight on the in-thread core.
			for (const entry of entries) {
				this.pending.delete(entry.id);
				this.inThreadCore().then(
					(core) => core.snapshot({ now: new Date(entry.nowMs), signal: entry.controller.signal, onProgress: entry.onProgress }).then(entry.resolve, entry.reject),
					entry.reject
				);
			}
			this.syncWatch();
		} else if (this.ensureWorker()) {
			for (const entry of entries) this.worker!.postMessage({ type: "snapshot", id: entry.id, nowMs: entry.nowMs });
		}
	}

	// --- in-thread fallback -------------------------------------------------------------------------------

	private inThreadCore(): Promise<CoreLike> {
		if (this.core) return Promise.resolve(this.core);
		this.corePromise ??= import("./service.ts").then(({ UsageIndexCore }) => {
			const core = new UsageIndexCore(this.cloneableOptions());
			this.core = core;
			if (this.listeners.size > 0 && this.options.watch !== false) core.startWatching(() => this.notify());
			return core;
		});
		return this.corePromise;
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// ignore
			}
		}
	}

	// --- watching -----------------------------------------------------------------------------------------

	private syncWatch(): void {
		const on = this.listeners.size > 0 && this.options.watch !== false;
		if (this.forcedInThread) {
			if (on) void this.inThreadCore().then((core) => this.listeners.size > 0 && core.startWatching(() => this.notify()));
			else this.core?.stopWatching();
			return;
		}
		if (on) {
			if (!this.ensureWorker()) return this.syncWatch();
			this.worker?.postMessage({ type: "watch", on: true });
		} else {
			this.worker?.postMessage({ type: "watch", on: false });
		}
	}
}

type WorkerMessage =
	| { type: "ready" }
	| { type: "progress"; id: number; progress: IndexProgress }
	| { type: "result"; id: number; data: UsageData | null }
	| { type: "error"; id: number; message: string }
	| { type: "changed" }
	| { type: "disposed"; id: number }
	| { type: "flushed"; id: number };

/** One index per option key per process. */
export function getUsageIndex(options: UsageIndexClientOptions = {}): UsageIndex {
	const key = optionKey(options);
	const reg = registry();
	let index = reg.get(key);
	if (!index) {
		index = new ClientIndex(key, options);
		reg.set(key, index);
	}
	return index;
}

/** Where an index currently runs (worker / in-thread core) — for tests and diagnostics. */
export function inspectUsageIndex(index: UsageIndex): ReturnType<ClientIndex["debugState"]> | null {
	return index instanceof ClientIndex ? index.debugState() : null;
}
