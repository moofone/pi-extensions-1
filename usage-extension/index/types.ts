/**
 * The usage index — shared contract between its layers (parse, discover/store, contrib, ledger, service, ux).
 * Design: ~/.pi/agent/plans/2026-10-01-usage-index-plan.md. READ-ONLY for lanes.
 *
 * Everything here must stay loadable under Node's native type stripping (types only, no runtime code
 * except plain functions and constants).
 */

import type { CollectProgress, MessageMeta, MissKind, ParsedSessionFile, SessionMessage, UsageData } from "../data.ts";
import type { ResolvedUsageSources, UsageFileKind } from "../sources.ts";

// =============================================================================
// Files
// =============================================================================

/** Canonical source order: kinds in this order, then path (UTF-16 code unit compare). Dedupe ownership,
 * session starts and aggregation order all follow it. */
export const KIND_ORDER: readonly UsageFileKind[] = ["pi", "claude-code", "codex-cli", "grok-build", "opencode-go"];

export function compareCanonical(a: { kind: UsageFileKind; path: string }, b: { kind: UsageFileKind; path: string }): number {
	const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
	if (k !== 0) return k;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface DiscoveredFile {
	path: string;
	kind: UsageFileKind;
	size: number;
	mtimeMs: number;
}

/** Where a parser stopped, so the next parse can read only what was appended. */
export interface ResumeState {
	/** Byte offset just past the last complete line consumed ("\n"). Bytes after it are re-read next time. */
	offset: number;
	/** sha1 hex of bytes [0, min(256, offset)) — a different head means the file was rewritten. */
	headHash: string;
	/** sha1 hex of bytes [max(0, offset - 256), offset) — must still match for a tail parse. */
	tailHash: string;
	/** Kind-specific parser state at `offset` (JSON-serialisable; opaque to every layer but the parser). */
	state: Record<string, unknown>;
}

/** Everything the index knows about one source file. `parsed` holds ALL of the file's records so far,
 * in raw file order, with `parsed.sessionId` already resolved through `fallbackSessionId`. */
export interface FileRecord {
	path: string;
	kind: UsageFileKind;
	size: number;
	mtimeMs: number;
	/** null → not resumable (opencode-go JSON documents, legacy-imported records): reparse fully on change. */
	resume: ResumeState | null;
	parsed: ParsedSessionFile;
}

// =============================================================================
// Parse layer (index/parse.ts)
// =============================================================================

export type FileChange =
	/** `record.parsed` replaces whatever was known before (new file, rewrite, truncation, non-resumable). */
	| { type: "full" }
	/** Only appended: `parsed.messages[messagesFrom..]` and `parsed.toolUsages[toolUsagesFrom..]` are new; earlier
	 * entries are byte-identical to the previous record's (same objects may be reused). sessionId/cwd unchanged. */
	| { type: "append"; messagesFrom: number; toolUsagesFrom: number }
	/** Size/mtime moved but nothing new was parsed (e.g. only a partial last line was added). */
	| { type: "none" };

export interface ParseOutcome {
	record: FileRecord;
	change: FileChange;
}

/** parse.ts: `parseFile(file, previous, signal) → ParseOutcome | null` (null: file vanished/unreadable). */
export type ParseFile = (file: DiscoveredFile, previous: FileRecord | undefined, signal?: AbortSignal) => Promise<ParseOutcome | null>;

// =============================================================================
// Store (index/store.ts)
// =============================================================================

export interface IndexStore {
	/** All persisted records (imports the legacy single-file cache once when no v8 store exists yet). */
	load(): Promise<Map<string, FileRecord>>;
	/** Mark a record new/changed (its shard becomes dirty). */
	put(record: FileRecord): void;
	delete(path: string): void;
	/** Write dirty shards atomically. Calls are serialised; cheap when nothing is dirty. Never throws. */
	flush(): Promise<void>;
	/** Last native payload (`buildUsageRollup` output) for instant first paint; null when none. */
	readRollup(): Promise<unknown | null>;
	writeRollup(payload: unknown): Promise<void>;
}

// =============================================================================
// Contribution layer (index/contrib.ts)
// =============================================================================

/** A message as it counts toward the aggregates: deduped, canonical provider, priced cost, adjacency meta
 * (computed in raw file order, as legacy) and its miss classification (null when not a miss). */
export interface CountedMessage {
	msg: SessionMessage;
	meta: MessageMeta;
	miss: MissKind | null;
}

/** What one file contributes after cross-file dedupe (ownership by canonical order). */
export interface FileContribution {
	path: string;
	kind: UsageFileKind;
	sessionId: string;
	/** projectLabelFromCwd(parsed.cwd). */
	project: string;
	/** Owned messages in raw file order, including nested tool-usage auxiliary messages (appended after the
	 * file's own messages, as legacy does). */
	counted: CountedMessage[];
}

export interface ContributionDelta {
	/** Every contribution was rebuilt (a global input changed, e.g. the cache-reporting provider set):
	 * the ledger must clear and add `replaced` from scratch. */
	reset: boolean;
	/** Files whose contribution changed in any way other than a pure append: remove the old, add this. */
	replaced: FileContribution[];
	/** Files that only gained owned messages at the end: add these. */
	appended: Array<{ path: string; counted: CountedMessage[] }>;
	/** Files gone (or now contributing nothing): remove. */
	removed: string[];
}

export interface ContributionUpdate {
	upserts: ParseOutcome[];
	removed: string[];
}

// =============================================================================
// Ledger (index/ledger.ts)
// =============================================================================

export interface LedgerStats {
	files: number;
	countedMessages: number;
	/** Quarter-hour buckets currently held. */
	buckets: number;
}

// =============================================================================
// Service (index/service.ts, worker.ts, client.ts)
// =============================================================================

export interface UsageIndexOptions {
	/** Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
	agentDir?: string;
	/** Defaults to `<agentDir>/sessions`. */
	sessionsDir?: string;
	/** Extra stores (Claude Code, Codex CLI, …); default: all disabled. */
	sources?: ResolvedUsageSources;
	/** Sharded store directory; default `<agentDir>/usage-index`. null → memory only. */
	storeDir?: string | null;
	/** Legacy single-file cache to import once; default `<agentDir>/usage-extension-cache.json`. null → none. */
	legacyCachePath?: string | null;
	/** Run the core in a worker thread (default true; falls back to in-thread when a Worker cannot start). */
	worker?: boolean;
	/** Parse workers for big batches (default: min(8, availableParallelism - 1); 0 → parse in the core thread). */
	parseWorkers?: number;
	/** Watch the source roots and refresh in the background while there are subscribers (default true). */
	watch?: boolean;
	/** Terminate the worker / drop memory after this long with no calls and no subscribers (default 10 min). */
	idleTtlMs?: number;
}

export type IndexProgress = CollectProgress;

export interface SnapshotOptions {
	now?: Date;
	signal?: AbortSignal;
	onProgress?: (progress: IndexProgress) => void;
}

/** Process-wide handle (`getUsageIndex(options)` in client.ts). All methods are async and never block the
 * calling thread for more than a few ms. */
export interface UsageIndex {
	/** Persisted last rollup payload for instant first paint (no refresh); null when none yet. */
	lastRollup(): Promise<unknown | null>;
	/** Bring the index up to date with the filesystem, then build a snapshot for `now`. Also persists the
	 * rollup for the next instant paint and schedules a store flush. Resolves null when aborted. */
	snapshot(options?: SnapshotOptions): Promise<UsageData | null>;
	/** Called (debounced) after a background refresh changed the data. Subscribing starts watching. */
	subscribe(listener: () => void): () => void;
	/** Flush the store and release the worker. */
	dispose(): Promise<void>;
}
