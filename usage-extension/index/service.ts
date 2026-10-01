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
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
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
import { UsageWatcher } from "./watch.ts";
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
		};
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

	/** Bring records, contributions and the ledger up to date with the filesystem. False when aborted. */
	async refresh(options: Pick<SnapshotOptions, "signal" | "onProgress"> = {}): Promise<boolean> {
		return (await this.refreshDetailed(options)).ok;
	}

	refreshDetailed(options: Pick<SnapshotOptions, "signal" | "onProgress"> = {}): Promise<RefreshResult> {
		return this.exclusive(() => this.refreshNow(options));
	}

	private async refreshNow(options: Pick<SnapshotOptions, "signal" | "onProgress">): Promise<RefreshResult> {
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
		const files = await this.discover(signal);
		if (!files) {
			if (firstLoad) this.ledger.apply(this.tracker.update({ upserts: this.recordUpserts(), removed: [] }));
			return { ok: false, changed: false };
		}

		const present = new Set<string>();
		const changedFiles: DiscoveredFile[] = [];
		for (const f of files) {
			present.add(f.path);
			const r = this.records.get(f.path);
			if (!r || r.size !== f.size || r.mtimeMs !== f.mtimeMs) changedFiles.push(f);
		}
		const removed: string[] = [];
		for (const p of this.records.keys()) if (!present.has(p)) removed.push(p);

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
			for (const r of this.records.values()) if (present.has(r.path) && !changedPaths.has(r.path)) unchanged.push({ record: r, change: { type: "full" } });
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
			const result = await this.refreshNow(options);
			if (!result.ok) return null;
			const data = this.ledger.snapshot(now);
			if (this.internal.persistRollup && this.storeDir) void this.store.writeRollup(buildUsageRollup(data, { now: options.now })).catch(() => {});
			return data;
		});
	}

	lastRollup(): Promise<unknown | null> {
		return this.store.readRollup();
	}

	/** Watch the source roots; `onChanged` fires after a background refresh changed the data. */
	startWatching(onChanged: () => void): void {
		if (this.watcher || this.disposed) return;
		this.watcher = new UsageWatcher({
			roots: watchRoots(this.options.sessionsDir, this.sources),
			onTrigger: async () => {
				try {
					const result = await this.refreshDetailed();
					if (result.ok && result.changed) onChanged();
				} catch {
					// A failed background refresh is retried by the next trigger / sweep.
				}
			},
		});
		this.watcher.start();
	}

	stopWatching(): void {
		this.watcher?.stop();
		this.watcher = null;
	}

	get watching(): boolean {
		return this.watcher !== null;
	}

	async dispose(): Promise<void> {
		this.stopWatching();
		await this.chain;
		await this.flush();
		this.disposed = true;
	}
}
