/**
 * Index orchestration: `UsageIndexCore` — a long-lived, incremental core that keeps the file records,
 * contributions and ledger up to date with the filesystem and builds snapshots from them.
 *
 *   refresh(): discover → find new/changed/removed (size + mtime) → parse changed (bounded concurrency
 *   in-thread; big batches go to the parse pool) → tracker.update → ledger.apply; store.put/delete;
 *   debounced store.flush.
 *
 * Runs unchanged in a worker thread (worker.ts), in-thread (fallback) or inside `collectUsageData`.
 * Must load under Node's native type stripping (explicit .ts imports, `import type`, no enums).
 */
import { availableParallelism } from "node:os";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { getAgentDir } from "../data.ts";
import type { UsageData } from "../data.ts";
import { buildUsageRollup } from "../native.ts";
import { disabledUsageSources } from "../sources.ts";
import type { ResolvedUsageSources, UsageFileKind } from "../sources.ts";
import { ContributionTracker } from "./contrib.ts";
import * as discoverModule from "./discover.ts";
import { UsageLedger } from "./ledger.ts";
import { ParsePool } from "./pool.ts";
import { applyParseDelta, parseFile } from "./parse.ts";
import { openIndexStore } from "./store.ts";
import type { OpenStoreOptions } from "./store.ts";
import { UsageWatcher, WATCH_DEBOUNCE_MS, WATCH_SWEEP_MS } from "./watch.ts";
import type { DiscoveredFile, FileRecord, IndexStore, ParseOutcome, SnapshotOptions, UsageIndexOptions } from "./types.ts";

/** Batches of at least this many changed files go to the parse pool. */
export const POOL_THRESHOLD_FILES = 200;
/** Store flush this long after the last change. */
export const FLUSH_DEBOUNCE_MS = 2000;
const INPROCESS_PARSE_CONCURRENCY = 8;
const PROGRESS_EVERY = 100;

export interface CoreInternalOptions {
	/** Persist the native rollup after each snapshot (default true). */
	persistRollup?: boolean;
	/** Debounce for store flushes (default 2 s). */
	flushDebounceMs?: number;
	/** Minimum changed files before the parse pool is used (default 200). */
	poolThreshold?: number;
	/** A full discovery is repeated when the last one is older than this (default 60 s). */
	sweepIntervalMs?: number;
	/** Debounce of watcher-driven background refreshes (default 750 ms). */
	watchDebounceMs?: number;
	/** More dirty paths than this → full discovery instead of per-path stats (default 2000). */
	maxDirtyPaths?: number;
	/** Explicit snapshots also re-stat files written within this window (default 15 min): watcher events
	 * can lag the write that just happened (typically the session asking for /usage), and the hot set is a
	 * few dozen stats. Background (watcher-triggered) refreshes rely on the dirty set alone. */
	hotWindowMs?: number;
	/** At most this many hot files are re-stat'ed per explicit snapshot (newest first; default 256). */
	maxHotPaths?: number;
}

interface Changes {
	changedFiles: DiscoveredFile[];
	removed: string[];
	present: Set<string> | null;
}

export interface RefreshResult {
	/** False when aborted. */
	ok: boolean;
	/** Records were added, changed or removed. */
	changed: boolean;
}

type DiscoverFn = (options: { sessionsDir: string; sources: ResolvedUsageSources; signal?: AbortSignal }) => Promise<DiscoveredFile[] | null>;

function defaultParseWorkers(): number {
	return Math.max(0, Math.min(8, availableParallelism() - 1));
}

/** Source roots to watch: the Pi sessions dir plus every enabled extra root. */
export function watchRoots(sessionsDir: string, sources: ResolvedUsageSources): string[] {
	const roots = [sessionsDir];
	for (const cfg of [sources.claudeCode, sources.codexCli, sources.grokBuild, sources.opencodeGo]) {
		if (cfg.enabled) for (const root of cfg.roots) if (!roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** Which source kind a path belongs to (for importing kind-less legacy records). Pi wins, as in discovery. */
function makeKindOf(sessionsDir: string, sources: ResolvedUsageSources): (path: string) => UsageFileKind {
	const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
	return (path) => {
		if (under(path, sessionsDir)) return "pi";
		const scans: Array<[ResolvedUsageSources[keyof ResolvedUsageSources], UsageFileKind]> = [
			[sources.claudeCode, "claude-code"],
			[sources.codexCli, "codex-cli"],
			[sources.grokBuild, "grok-build"],
			[sources.opencodeGo, "opencode-go"],
		];
		for (const [cfg, kind] of scans) if (cfg.enabled && cfg.roots.some((root) => under(path, root))) return kind;
		return "pi";
	};
}

/** Whether `path` is a source file under discovery's rules, and of which kind (null: not one). */
function makeFileKind(sessionsDir: string, sources: ResolvedUsageSources): (path: string) => UsageFileKind | null {
	const under = (path: string, root: string) => path.startsWith(root.endsWith(sep) ? root : root + sep);
	const openCodeRoot = (root: string) => {
		const n = root.replace(/\/+$/, "");
		return n.endsWith("/storage/message") ? n : n.endsWith("/storage") ? join(n, "message") : join(n, "storage", "message");
	};
	return (path) => {
		const name = basename(path);
		if (name.endsWith(".jsonl") && under(path, sessionsDir)) return "pi";
		if (sources.claudeCode.enabled && name.endsWith(".jsonl") && sources.claudeCode.roots.some((r) => under(path, r))) return "claude-code";
		if (sources.codexCli.enabled && name.endsWith(".jsonl") && sources.codexCli.roots.some((r) => under(path, r))) return "codex-cli";
		if (sources.grokBuild.enabled && name === "updates.jsonl" && sources.grokBuild.roots.some((r) => under(path, r))) return "grok-build";
		if (sources.opencodeGo.enabled && name.startsWith("msg_") && name.endsWith(".json") && sources.opencodeGo.roots.some((r) => under(path, openCodeRoot(r)))) return "opencode-go";
		return null;
	};
}

export class UsageIndexCore {
	readonly options: Required<Pick<UsageIndexOptions, "sessionsDir">> & UsageIndexOptions;
	private readonly sources: ResolvedUsageSources;
	private readonly storeDir: string | null;
	private readonly legacyCachePath: string | null;
	private readonly internal: Required<CoreInternalOptions>;
	private readonly store: IndexStore;
	private readonly discoverer: { discover: DiscoverFn } | null;
	private records = new Map<string, FileRecord>();
	private tracker = new ContributionTracker();
	private ledger = new UsageLedger();
	private loaded = false;
	private legacyExisted = false;
	private chain: Promise<unknown> = Promise.resolve();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private watcher: UsageWatcher | null = null;
	private disposed = false;
	/** Watch for the core's whole life (options.watch !== false) and refresh from dirty paths. */
	private readonly live: boolean;
	private readonly fileKind: (path: string) => UsageFileKind | null;
	private dirty = new Set<string>();
	private dirtyDirs = new Set<string>();
	private sweepNeeded = true;
	private lastFullAt = 0;
	private onChanged: (() => void) | null = null;
	/** Diagnostics: full discoveries run / dirty paths stat'ed so far. */
	fullSweeps = 0;
	dirtyPathsChecked = 0;

	constructor(options: UsageIndexOptions = {}, internal: CoreInternalOptions = {}) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.sources = options.sources ?? disabledUsageSources();
		this.options = { ...options, sessionsDir: options.sessionsDir ?? join(agentDir, "sessions") };
		this.storeDir = options.storeDir === undefined ? join(agentDir, "usage-index") : options.storeDir;
		this.legacyCachePath = options.legacyCachePath === undefined ? join(agentDir, "usage-extension-cache.json") : options.legacyCachePath;
		this.internal = {
			persistRollup: internal.persistRollup ?? true,
			flushDebounceMs: internal.flushDebounceMs ?? FLUSH_DEBOUNCE_MS,
			poolThreshold: internal.poolThreshold ?? POOL_THRESHOLD_FILES,
			sweepIntervalMs: internal.sweepIntervalMs ?? WATCH_SWEEP_MS,
			watchDebounceMs: internal.watchDebounceMs ?? WATCH_DEBOUNCE_MS,
			maxDirtyPaths: internal.maxDirtyPaths ?? 2000,
			hotWindowMs: internal.hotWindowMs ?? 15 * 60_000,
			maxHotPaths: internal.maxHotPaths ?? 256,
		};
		this.live = options.watch !== false;
		this.fileKind = makeFileKind(this.options.sessionsDir, this.sources);
		// `kindOf` is an optional store capability; harmless when the store ignores it.
		const storeOptions: OpenStoreOptions & { kindOf?: (path: string) => UsageFileKind } = {
			legacyCachePath: this.legacyCachePath,
			kindOf: makeKindOf(this.options.sessionsDir, this.sources),
		};
		this.store = openIndexStore(this.storeDir, storeOptions);
		const Discoverer = (discoverModule as unknown as Record<string, unknown>).Discoverer as (new () => { discover: DiscoverFn }) | undefined;
		this.discoverer = Discoverer ? new Discoverer() : null;
	}

	/** Serialise refresh/snapshot work: one at a time, in call order. */
	private exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.catch(() => {});
		return run;
	}

	private discover(signal?: AbortSignal): Promise<DiscoveredFile[] | null> {
		const options = { sessionsDir: this.options.sessionsDir, sources: this.sources, signal };
		return this.discoverer ? this.discoverer.discover(options) : discoverModule.discoverFiles(options);
	}

	private ensureWatcher(): UsageWatcher | null {
		if (this.watcher || this.disposed) return this.watcher;
		const watcher = new UsageWatcher({
			roots: watchRoots(this.options.sessionsDir, this.sources),
			debounceMs: this.internal.watchDebounceMs,
			sweepMs: this.internal.sweepIntervalMs,
			onEvent: (path) => {
				if (path === null) this.sweepNeeded = true;
				else if (path.endsWith(".jsonl") || path.endsWith(".json")) {
					this.dirty.add(path);
					if (this.dirty.size > this.internal.maxDirtyPaths) this.sweepNeeded = true;
				}
				else if (!basename(path).includes(".")) {
					this.dirtyDirs.add(path); // probably a directory appeared/moved/vanished
					if (this.dirtyDirs.size > this.internal.maxDirtyPaths) this.sweepNeeded = true;
				}
			},
			onError: () => {
				this.sweepNeeded = true;
			},
		});
		this.watcher = watcher;
		this.sweepNeeded = true; // events before this point were not seen
		watcher.start();
		return watcher;
	}

	/** A directory event: add the files it may have brought (unknown source files below it) or taken away
	 * (known records below a vanished directory) to the dirty set. */
	private async expandDirectory(dir: string, dirty: Set<string>): Promise<void> {
		let isDir = false;
		try {
			isDir = (await lstat(dir)).isDirectory();
		} catch {
			// vanished
		}
		if (!isDir) {
			const prefix = dir + sep;
			for (const path of this.records.keys()) if (path.startsWith(prefix)) dirty.add(path);
			return;
		}
		try {
			for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const path = join(entry.parentPath, entry.name);
				if (!this.records.has(path) && this.fileKind(path)) dirty.add(path);
			}
		} catch {
			this.sweepNeeded = true;
		}
	}

	/** New/changed/removed files: a full discovery (first use, sweep needed, stale, or no healthy watch) or
	 * just the paths the watcher reported dirty. `present` is the full file set (null for dirty-only). */
	private async findChanges(signal?: AbortSignal, includeHot = false): Promise<Changes | null> {
		const watcher = this.live ? this.watcher : null;
		if (watcher && !watcher.healthy) watcher.attach();
		const trusted = watcher !== null && watcher.healthy && !this.sweepNeeded && this.dirty.size <= this.internal.maxDirtyPaths && performance.now() - this.lastFullAt < this.internal.sweepIntervalMs;
		if (!trusted) {
			// Events arriving during the discovery stay in the (fresh) dirty set for the next refresh.
			this.dirty = new Set();
			this.dirtyDirs = new Set();
			const startedAt = performance.now();
			this.fullSweeps++;
			const files = await this.discover(signal);
			if (!files) return null;
			const present = new Set<string>();
			const changedFiles: DiscoveredFile[] = [];
			for (const f of files) {
				present.add(f.path);
				const r = this.records.get(f.path);
				if (!r || r.size !== f.size || r.mtimeMs !== f.mtimeMs) changedFiles.push(f);
			}
			const removed: string[] = [];
			for (const p of this.records.keys()) if (!present.has(p)) removed.push(p);
			if (watcher && watcher.healthy) {
				this.sweepNeeded = false;
				this.lastFullAt = startedAt;
			}
			return { changedFiles, removed, present };
		}
		// Dirty-only: nothing dirty means no filesystem access at all (plus the hot set on explicit snapshots).
		const dirty = this.dirty;
		const dirs = this.dirtyDirs;
		this.dirty = new Set();
		this.dirtyDirs = new Set();
		if (includeHot) for (const path of this.hotPaths()) dirty.add(path);
		for (const dir of dirs) await this.expandDirectory(dir, dirty);
		this.dirtyPathsChecked += dirty.size;
		const changedFiles: DiscoveredFile[] = [];
		const removed: string[] = [];
		try {
			await Promise.all(
				[...dirty].map(async (path) => {
					const kind = this.fileKind(path);
					const known = this.records.get(path);
					if (!kind && !known) return;
					try {
						const st = await lstat(path);
						if (!st.isFile()) {
							if (known) removed.push(path);
							return;
						}
						if (!known || known.size !== st.size || known.mtimeMs !== st.mtimeMs) changedFiles.push({ path, kind: known?.kind ?? kind!, size: st.size, mtimeMs: st.mtimeMs });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
							if (known) removed.push(path);
						} else {
							throw error;
						}
					}
				})
			);
		} catch {
			this.sweepNeeded = true;
			return this.findChanges(signal, includeHot);
		}
		return { changedFiles, removed, present: null };
	}

	/** Records written within the hot window, newest first, capped. */
	private hotPaths(): string[] {
		const since = Date.now() - this.internal.hotWindowMs;
		const hot: Array<[string, number]> = [];
		for (const [path, r] of this.records) if (r.mtimeMs >= since) hot.push([path, r.mtimeMs]);
		hot.sort((a, b) => b[1] - a[1]);
		return hot.slice(0, this.internal.maxHotPaths).map(([path]) => path);
	}

	/** Bring records, contributions and the ledger up to date with the filesystem. False when aborted. */
	async refresh(options: Pick<SnapshotOptions, "signal" | "onProgress"> = {}): Promise<boolean> {
		return (await this.refreshDetailed(options)).ok;
	}

	refreshDetailed(options: Pick<SnapshotOptions, "signal" | "onProgress"> = {}): Promise<RefreshResult> {
		return this.exclusive(() => this.refreshNow(options));
	}

	private async refreshNow(options: Pick<SnapshotOptions, "signal" | "onProgress">, includeHot = false): Promise<RefreshResult> {
		const { signal, onProgress } = options;
		if (signal?.aborted || this.disposed) return { ok: false, changed: false };
		const firstLoad = !this.loaded;
		if (firstLoad) {
			if (this.legacyCachePath) this.legacyExisted = await stat(this.legacyCachePath).then(() => true, () => false);
			this.records = await this.store.load();
			this.loaded = true;
			if (signal?.aborted) {
				// Keep the loaded records consistent with the (still empty) ledger on the next pass.
				this.ledger.apply(this.tracker.update({ upserts: this.recordUpserts(), removed: [] }));
				return { ok: false, changed: false };
			}
		}
		if (this.live) this.ensureWatcher();
		let changes: Changes | null;
		try {
			changes = await this.findChanges(signal, includeHot);
		} catch {
			changes = null;
			this.sweepNeeded = true;
		}
		if (!changes) {
			this.sweepNeeded = true;
			if (firstLoad) this.ledger.apply(this.tracker.update({ upserts: this.recordUpserts(), removed: [] }));
			return { ok: false, changed: false };
		}
		const { changedFiles, removed, present } = changes;

		const hadRecords = this.records.size > 0;
		const mode = hadRecords ? "update" : firstLoad && this.legacyExisted ? "rebuild" : "first-run";
		let sinceMs: number | null = null;
		if (mode === "update") for (const r of this.records.values()) if (r.mtimeMs > (sinceMs ?? 0)) sinceMs = r.mtimeMs;
		let parsed = 0;
		const report = () => onProgress?.({ mode, filesToParse: changedFiles.length, filesParsed: parsed, sinceMs });
		report();

		// Unchanged records the tracker has not seen yet (first refresh after load) go in as one bulk update.
		const unchanged: ParseOutcome[] = [];
		if (firstLoad) {
			const changedPaths = new Set(changedFiles.map((f) => f.path));
			for (const r of this.records.values()) if (present !== null && present.has(r.path) && !changedPaths.has(r.path)) unchanged.push({ record: r, change: { type: "full" } });
		}

		const upserts: ParseOutcome[] = [];
		const vanished: string[] = [];
		let aborted = false;
		let pool: ParsePool | null = null;
		const poolSize = this.options.parseWorkers ?? defaultParseWorkers();
		if (changedFiles.length >= this.internal.poolThreshold && poolSize > 0) pool = ParsePool.tryCreate(poolSize);
		try {
			let next = 0;
			const lanes = pool ? pool.size + 2 : INPROCESS_PARSE_CONCURRENCY;
			await Promise.all(
				Array.from({ length: Math.min(lanes, Math.max(1, changedFiles.length)) }, async () => {
					while (next < changedFiles.length) {
						if (signal?.aborted) {
							aborted = true;
							return;
						}
						const file = changedFiles[next++]!;
						const previous = this.records.get(file.path);
						let outcome: ParseOutcome | null;
						try {
							outcome = await this.parseOne(file, previous, pool, signal);
						} catch {
							outcome = null;
						}
						if (signal?.aborted) {
							aborted = true;
							return; // Never keep a partial parse.
						}
						parsed++;
						if (parsed % PROGRESS_EVERY === 0 || parsed === changedFiles.length) report();
						if (!outcome) {
							vanished.push(file.path);
							continue;
						}
						this.records.set(file.path, outcome.record);
						this.store.put(outcome.record);
						upserts.push(outcome);
					}
				})
			);
		} finally {
			pool?.close();
		}

		if (aborted) this.sweepNeeded = true; // unparsed files must be found again
		// Apply whatever finished (also when aborted) so records, tracker and ledger never disagree.
		const gone = [...removed];
		for (const p of vanished) if (this.records.has(p)) gone.push(p);
		for (const p of gone) {
			this.records.delete(p);
			this.store.delete(p);
		}
		// Records order for the tracker: unchanged first, then freshly parsed (canonical sorting is its job).
		const allUpserts = unchanged.length > 0 ? [...unchanged, ...upserts] : upserts;
		const changed = upserts.length > 0 || gone.length > 0;
		if (allUpserts.length > 0 || gone.length > 0) this.ledger.apply(this.tracker.update({ upserts: allUpserts, removed: gone }));
		if (changed) this.scheduleFlush();
		return { ok: !aborted, changed };
	}

	private recordUpserts(): ParseOutcome[] {
		return [...this.records.values()].map((record) => ({ record, change: { type: "full" } as const }));
	}

	private async parseOne(file: DiscoveredFile, previous: FileRecord | undefined, pool: ParsePool | null, signal?: AbortSignal): Promise<ParseOutcome | null> {
		if (pool) {
			const result = await pool.parse(file, previous?.resume ?? null, signal);
			if (result !== "failed") return result ? applyParseDelta(file, previous, result) : null;
			if (signal?.aborted) return null;
		}
		return parseFile(file, previous, signal);
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.disposed || !this.storeDir) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.store.flush();
		}, this.internal.flushDebounceMs);
		this.flushTimer.unref?.();
	}

	/** Write dirty shards now (cancels the pending debounced flush). */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.store.flush();
	}

	async snapshot(options: SnapshotOptions = {}): Promise<UsageData | null> {
		const now = options.now ?? new Date();
		return this.exclusive(async () => {
			const result = await this.refreshNow(options, true);
			if (!result.ok) return null;
			const data = this.ledger.snapshot(now);
			if (this.internal.persistRollup && this.storeDir) void this.store.writeRollup(buildUsageRollup(data, { now: options.now })).catch(() => {});
			return data;
		});
	}

	lastRollup(): Promise<unknown | null> {
		return this.store.readRollup();
	}

	/** Subscribers: `onChanged` fires after a background refresh changed the data. The watcher itself (dirty
	 * tracking) runs for the core's whole life when `watch !== false`; this only adds the background trigger. */
	startWatching(onChanged: () => void): void {
		if (this.disposed) return;
		this.onChanged = onChanged;
		const watcher = this.ensureWatcher();
		watcher?.setTrigger(async () => {
			try {
				const result = await this.refreshDetailed();
				if (result.ok && result.changed) this.onChanged?.();
			} catch {
				// A failed background refresh is retried by the next trigger / sweep.
			}
		});
	}

	stopWatching(): void {
		this.onChanged = null;
		if (this.live) this.watcher?.setTrigger(null);
		else this.dropWatcher();
	}

	private dropWatcher(): void {
		this.watcher?.stop();
		this.watcher = null;
		this.sweepNeeded = true;
	}

	get watching(): boolean {
		return this.watcher !== null;
	}

	async dispose(): Promise<void> {
		this.onChanged = null;
		this.dropWatcher();
		await this.chain;
		await this.flush();
		this.disposed = true;
	}
}
