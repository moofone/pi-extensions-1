/**
 * Index orchestration (LANE service OWNS THIS FILE, plus worker.ts / client.ts / pool.ts / watch.ts).
 * Scaffold: an in-thread core — discover → parse changed (serially) → contrib → ledger → snapshot — with the
 * memory-only store stub. Keep the exported API.
 */
import { join } from "node:path";
import { getAgentDir } from "../data.ts";
import type { UsageData } from "../data.ts";
import { buildUsageRollup } from "../native.ts";
import { disabledUsageSources } from "../sources.ts";
import { ContributionTracker } from "./contrib.ts";
import { discoverFiles } from "./discover.ts";
import { UsageLedger } from "./ledger.ts";
import { parseFile } from "./parse.ts";
import { openIndexStore } from "./store.ts";
import type { FileRecord, IndexStore, ParseOutcome, SnapshotOptions, UsageIndexOptions } from "./types.ts";

export class UsageIndexCore {
	readonly options: Required<Pick<UsageIndexOptions, "sessionsDir">> & UsageIndexOptions;
	private store: IndexStore;
	private records = new Map<string, FileRecord>();
	private tracker = new ContributionTracker();
	private ledger = new UsageLedger();
	private loaded = false;

	constructor(options: UsageIndexOptions = {}) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.options = { ...options, sessionsDir: options.sessionsDir ?? join(agentDir, "sessions") };
		const storeDir = options.storeDir === undefined ? join(agentDir, "usage-index") : options.storeDir;
		const legacy = options.legacyCachePath === undefined ? join(agentDir, "usage-extension-cache.json") : options.legacyCachePath;
		this.store = openIndexStore(storeDir, { legacyCachePath: legacy });
	}

	/** Bring records, contributions and the ledger up to date with the filesystem. False when aborted. */
	async refresh(options: Pick<SnapshotOptions, "signal" | "onProgress"> = {}): Promise<boolean> {
		const { signal, onProgress } = options;
		if (!this.loaded) {
			this.records = await this.store.load();
			if (this.records.size > 0) this.ledger.apply(this.tracker.update({ upserts: [...this.records.values()].map((record) => ({ record, change: { type: "full" } })), removed: [] }));
			this.loaded = true;
		}
		const files = await discoverFiles({ sessionsDir: this.options.sessionsDir, sources: this.options.sources ?? disabledUsageSources(), signal });
		if (!files) return false;
		const present = new Set(files.map((f) => f.path));
		const removed = [...this.records.keys()].filter((p) => !present.has(p));
		const changed = files.filter((f) => {
			const r = this.records.get(f.path);
			return !r || r.size !== f.size || r.mtimeMs !== f.mtimeMs;
		});
		let sinceMs: number | null = null;
		for (const r of this.records.values()) if (r.mtimeMs > (sinceMs ?? 0)) sinceMs = r.mtimeMs;
		const mode = this.records.size > 0 ? "update" : "first-run";
		let parsed = 0;
		onProgress?.({ mode, filesToParse: changed.length, filesParsed: 0, sinceMs });
		const upserts: ParseOutcome[] = [];
		for (const file of changed) {
			if (signal?.aborted) return false;
			const outcome = await parseFile(file, this.records.get(file.path), signal);
			parsed++;
			if (parsed % 100 === 0 || parsed === changed.length) onProgress?.({ mode, filesToParse: changed.length, filesParsed: parsed, sinceMs });
			if (!outcome) continue;
			this.records.set(file.path, outcome.record);
			this.store.put(outcome.record);
			upserts.push(outcome);
		}
		for (const p of removed) {
			this.records.delete(p);
			this.store.delete(p);
		}
		if (upserts.length > 0 || removed.length > 0) this.ledger.apply(this.tracker.update({ upserts, removed }));
		void this.store.flush();
		return true;
	}

	async snapshot(options: SnapshotOptions = {}): Promise<UsageData | null> {
		if (!(await this.refresh(options))) return null;
		const data = this.ledger.snapshot(options.now ?? new Date());
		void this.store.writeRollup(buildUsageRollup(data, { now: options.now }));
		return data;
	}

	lastRollup(): Promise<unknown | null> {
		return this.store.readRollup();
	}

	async dispose(): Promise<void> {
		await this.store.flush();
	}
}
