/**
 * Persistent index store, v8: `manifest.json` {version: 8, shards: 64} + `shard-NN.json`.
 *
 * Files are spread over 64 shards by FNV-1a (32 bit, UTF-8 bytes) of their path. Every shard is
 * self-contained (own name-interning table, compact tuples for messages / tool usages, per-file kind, size,
 * mtime, sessionId, cwd and resume point), so a change rewrites 1/64 of the data: `put`/`delete` mark the
 * shard dirty and `flush()` writes only dirty shards (tmp + rename). A corrupt / unknown shard is dropped
 * (its files reparse). With no valid manifest the legacy single-file cache is imported once (never touched).
 *
 * Numbers are persisted at full precision (unlike the v7 cache, which rounded per-class costs to 1e-9), so
 * a reload is exact.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadUsageCache } from "../data.ts";
import type { ChildToolUsage, SessionMessage, ToolUsageRecord, UsageAmount } from "../data.ts";
import type { UsageFileKind } from "../sources.ts";
import { KIND_ORDER } from "./types.ts";
import type { FileRecord, IndexStore, ResumeState } from "./types.ts";

export const STORE_VERSION = 8;
export const SHARD_COUNT = 64;

export interface OpenStoreOptions {
	/** Legacy single-file cache (v6/v7) imported once when the store has nothing yet; null → none. */
	legacyCachePath?: string | null;
	/** Kind of a legacy-imported file; null/undefined → default path heuristic. */
	kindOf?: (path: string) => UsageFileKind | null;
}

/** FNV-1a 32-bit of the UTF-8 bytes of `path`. */
export function fnv1a(path: string): number {
	const bytes = Buffer.from(path, "utf8");
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i]!;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function shardOf(path: string): number {
	return fnv1a(path) % SHARD_COUNT;
}

/** Kind guess for a legacy-imported path (the legacy cache did not record it). */
export function defaultKindOf(path: string): UsageFileKind {
	if (path.includes("/.claude/")) return "claude-code";
	if (path.includes("/.codex/")) return "codex-cli";
	if (path.includes("/.grok/")) return "grok-build";
	const base = path.slice(path.lastIndexOf("/") + 1);
	if (base.startsWith("msg_") && base.endsWith(".json") && path.includes("/storage/")) return "opencode-go";
	return "pi";
}

// ---------------------------------------------------------------------------
// Tuple encoding (v7 layout, no rounding)
// ---------------------------------------------------------------------------

const MESSAGE_BASE = 13;
const MESSAGE_FULL = 18;

type UsageTuple = [number, number, number, number, number, number];
type MessageTuple = number[];
type ChildTuple = [number, number, UsageTuple];
type ToolTuple = [number, number, UsageTuple | null, number, ChildTuple[]];
type FileTuple = [string, number, number, string, number, [number, string, string, Record<string, unknown>] | null, MessageTuple[], ToolTuple[]];

interface ShardFile {
	version: number;
	shard: number;
	names: string[];
	files: Record<string, FileTuple>;
}

class Interner {
	readonly names: string[] = [];
	private readonly index = new Map<string, number>();
	intern(name: string): number {
		let idx = this.index.get(name);
		if (idx === undefined) {
			idx = this.names.length;
			this.names.push(name);
			this.index.set(name, idx);
		}
		return idx;
	}
}

function usageTuple(u: UsageAmount): UsageTuple {
	return [u.cost, u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning];
}

function usageFrom(value: unknown): UsageAmount | null {
	if (!Array.isArray(value) || value.length !== 6) return null;
	for (const part of value) if (typeof part !== "number" || !Number.isFinite(part)) return null;
	return { cost: value[0], input: value[1], output: value[2], cacheRead: value[3], cacheWrite: value[4], reasoning: value[5] };
}

function encodeRecord(record: FileRecord, names: Interner): FileTuple {
	const messages = record.parsed.messages.map((m): MessageTuple => {
		const tuple: MessageTuple = [
			names.intern(m.provider),
			names.intern(m.model),
			m.cost,
			m.input,
			m.output,
			m.cacheRead,
			m.cacheWrite,
			m.timestamp,
			names.intern(m.thinkingLevel),
			m.reasoning,
			m.afterCompaction ? 1 : 0,
			m.source === "auxiliary" ? 1 : 0,
			names.intern(m.source === "auxiliary" ? m.sourceId : ""),
		];
		const costInput = m.costInput ?? 0;
		const costOutput = m.costOutput ?? 0;
		const costCacheRead = m.costCacheRead ?? 0;
		const costCacheWrite = m.costCacheWrite ?? 0;
		const cacheWrite1h = m.cacheWrite1h ?? 0;
		if (costInput !== 0 || costOutput !== 0 || costCacheRead !== 0 || costCacheWrite !== 0 || cacheWrite1h !== 0) {
			tuple.push(costInput, costOutput, costCacheRead, costCacheWrite, cacheWrite1h);
		}
		return tuple;
	});
	const toolUsages = record.parsed.toolUsages.map(
		(tool): ToolTuple => [
			names.intern(tool.sourceId),
			tool.timestamp,
			tool.reportedUsage ? usageTuple(tool.reportedUsage) : null,
			names.intern(tool.runId),
			tool.children.map((child): ChildTuple => [child.resultIndex, names.intern(child.sessionFile), usageTuple(child.usage)]),
		]
	);
	const resume = record.resume ? ([record.resume.offset, record.resume.headHash, record.resume.tailHash, record.resume.state] as [number, string, string, Record<string, unknown>]) : null;
	return [record.kind, record.size, record.mtimeMs, record.parsed.sessionId, names.intern(record.parsed.cwd), resume, messages, toolUsages];
}

function decodeRecord(path: string, tuple: unknown, names: string[]): FileRecord | null {
	if (!Array.isArray(tuple) || tuple.length !== 8) return null;
	const [kind, size, mtimeMs, sessionId, cwdIdx, resumeRaw, messageTuples, toolTuples] = tuple as unknown[];
	if (typeof kind !== "string" || !KIND_ORDER.includes(kind as UsageFileKind)) return null;
	const cwd = names[cwdIdx as number];
	if (typeof size !== "number" || typeof mtimeMs !== "number" || typeof sessionId !== "string" || typeof cwd !== "string") return null;
	if (!Array.isArray(messageTuples) || !Array.isArray(toolTuples)) return null;

	let resume: ResumeState | null = null;
	if (resumeRaw !== null) {
		if (!Array.isArray(resumeRaw) || resumeRaw.length !== 4) return null;
		const [offset, headHash, tailHash, state] = resumeRaw;
		if (typeof offset !== "number" || typeof headHash !== "string" || typeof tailHash !== "string" || !state || typeof state !== "object") return null;
		resume = { offset, headHash, tailHash, state };
	}

	const messages: SessionMessage[] = new Array(messageTuples.length);
	for (let i = 0; i < messageTuples.length; i++) {
		const t = messageTuples[i] as number[];
		if (!Array.isArray(t) || (t.length !== MESSAGE_FULL && t.length !== MESSAGE_BASE)) return null;
		const provider = names[t[0]!];
		const model = names[t[1]!];
		const thinkingLevel = names[t[8]!];
		const sourceId = names[t[12]!];
		if (typeof provider !== "string" || typeof model !== "string" || typeof thinkingLevel !== "string" || typeof sourceId !== "string") return null;
		if (t[11] !== 0 && t[11] !== 1) return null;
		messages[i] = {
			provider,
			model,
			thinkingLevel,
			source: t[11] === 1 ? "auxiliary" : "assistant",
			sourceId,
			cost: Number(t[2]) || 0,
			input: Number(t[3]) || 0,
			output: Number(t[4]) || 0,
			cacheRead: Number(t[5]) || 0,
			cacheWrite: Number(t[6]) || 0,
			timestamp: Number(t[7]) || 0,
			reasoning: Number(t[9]) || 0,
			afterCompaction: t[10] === 1,
			costInput: Number(t[13]) || 0,
			costOutput: Number(t[14]) || 0,
			costCacheRead: Number(t[15]) || 0,
			costCacheWrite: Number(t[16]) || 0,
			cacheWrite1h: Number(t[17]) || 0,
		};
	}

	const toolUsages: ToolUsageRecord[] = [];
	for (const raw of toolTuples) {
		if (!Array.isArray(raw) || raw.length !== 5 || !Array.isArray(raw[4])) return null;
		const sourceId = names[raw[0]];
		const runId = names[raw[3]];
		const reportedUsage = raw[2] === null ? null : usageFrom(raw[2]);
		if (typeof sourceId !== "string" || typeof runId !== "string" || (raw[2] !== null && !reportedUsage)) return null;
		const children: ChildToolUsage[] = [];
		for (const child of raw[4] as unknown[]) {
			if (!Array.isArray(child) || child.length !== 3) return null;
			const sessionFile = names[child[1]];
			const usage = usageFrom(child[2]);
			if (typeof child[0] !== "number" || typeof sessionFile !== "string" || !usage) return null;
			children.push({ resultIndex: child[0], sessionFile, usage });
		}
		toolUsages.push({ sourceId, timestamp: Number(raw[1]) || 0, reportedUsage, runId, children });
	}

	return { path, kind: kind as UsageFileKind, size, mtimeMs, resume, parsed: { sessionId, cwd, messages, toolUsages } };
}

function shardName(n: number): string {
	return `shard-${String(n).padStart(2, "0")}.json`;
}

async function writeAtomic(path: string, payload: string): Promise<void> {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await writeFile(tmp, payload, "utf8");
	await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** `dir` null → memory only. */
export function openIndexStore(dir: string | null, options: OpenStoreOptions = {}): IndexStore {
	const records = new Map<string, FileRecord>();
	const shardPaths: Array<Set<string>> = Array.from({ length: SHARD_COUNT }, () => new Set<string>());
	const dirty = new Set<number>();
	let rollup: unknown = null;
	/** True while no valid manifest exists on disk: the first write must (re)write every shard + the manifest. */
	let needsFullWrite = true;
	let loading: Promise<void> | null = null;

	const markDirty = (shard: number) => {
		if (needsFullWrite) for (let i = 0; i < SHARD_COUNT; i++) dirty.add(i);
		else dirty.add(shard);
	};

	const insert = (record: FileRecord) => {
		records.set(record.path, record);
		shardPaths[shardOf(record.path)]!.add(record.path);
	};

	async function readShard(n: number): Promise<{ records: FileRecord[]; ok: boolean }> {
		let raw: ShardFile;
		try {
			raw = JSON.parse(await readFile(join(dir!, shardName(n)), "utf8"));
		} catch {
			return { records: [], ok: false };
		}
		if (!raw || raw.version !== STORE_VERSION || raw.shard !== n || !Array.isArray(raw.names) || typeof raw.files !== "object" || raw.files === null) {
			return { records: [], ok: false };
		}
		const out: FileRecord[] = [];
		for (const path of Object.keys(raw.files)) {
			if (shardOf(path) !== n) continue;
			const record = decodeRecord(path, raw.files[path], raw.names);
			if (record) out.push(record);
		}
		return { records: out, ok: true };
	}

	async function doLoad(): Promise<void> {
		if (dir === null) return;
		let manifestOk = false;
		try {
			const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
			manifestOk = manifest?.version === STORE_VERSION && manifest?.shards === SHARD_COUNT;
		} catch {
			manifestOk = false;
		}
		if (manifestOk) {
			needsFullWrite = false;
			const shards = await Promise.all(Array.from({ length: SHARD_COUNT }, (_, n) => readShard(n)));
			shards.forEach((shard, n) => {
				if (!shard.ok) dirty.add(n); // rewrite a dropped shard (its files reparse and are put again)
				for (const record of shard.records) if (!records.has(record.path)) insert(record);
			});
			return;
		}
		const legacy = options.legacyCachePath;
		if (legacy) {
			const imported = await loadUsageCache(legacy);
			for (const [path, state] of imported) {
				if (records.has(path)) continue;
				const kind = options.kindOf?.(path) ?? defaultKindOf(path);
				insert({ path, kind, size: state.size, mtimeMs: state.mtimeMs, resume: null, parsed: state.parsed });
			}
			if (imported.size > 0) for (let i = 0; i < SHARD_COUNT; i++) dirty.add(i);
		}
	}

	async function writeDirty(): Promise<void> {
		if (dir === null || dirty.size === 0) return;
		const shards = [...dirty];
		dirty.clear();
		const full = needsFullWrite;
		let failed = false;
		try {
			await mkdir(dir, { recursive: true });
		} catch {
			failed = true;
		}
		if (!failed) {
			await Promise.all(
				shards.map(async (n) => {
					try {
						const names = new Interner();
						const files: Record<string, FileTuple> = {};
						for (const path of [...shardPaths[n]!].sort()) {
							const record = records.get(path);
							if (record) files[path] = encodeRecord(record, names);
						}
						const payload: ShardFile = { version: STORE_VERSION, shard: n, names: names.names, files };
						await writeAtomic(join(dir, shardName(n)), JSON.stringify(payload));
					} catch {
						failed = true;
						dirty.add(n);
					}
				})
			);
		}
		if (failed) {
			for (const n of shards) dirty.add(n);
			return;
		}
		if (full) {
			try {
				await writeAtomic(join(dir, "manifest.json"), JSON.stringify({ version: STORE_VERSION, shards: SHARD_COUNT }));
				needsFullWrite = false;
			} catch {
				for (const n of shards) dirty.add(n);
			}
		}
	}

	let active: Promise<void> | null = null;
	let queued: Promise<void> | null = null;
	const flush = (): Promise<void> => {
		if (!active) {
			const run: Promise<void> = writeDirty()
				.catch(() => {})
				.finally(() => {
					if (active === run) active = null;
				});
			active = run;
			return run;
		}
		if (!queued) {
			queued = active.then(() => {
				queued = null;
				return flush();
			});
		}
		return queued;
	};

	return {
		load() {
			loading ??= doLoad();
			return loading.then(() => new Map(records));
		},
		put(record) {
			markDirty(shardOf(record.path));
			insert(record);
		},
		delete(path) {
			if (!records.delete(path)) return;
			const shard = shardOf(path);
			shardPaths[shard]!.delete(path);
			markDirty(shard);
		},
		flush,
		async readRollup() {
			if (dir === null) return rollup;
			try {
				return JSON.parse(await readFile(join(dir, "rollup.json"), "utf8"));
			} catch {
				return null;
			}
		},
		async writeRollup(payload) {
			if (dir === null) {
				rollup = payload;
				return;
			}
			try {
				await mkdir(dir, { recursive: true });
				await writeAtomic(join(dir, "rollup.json"), JSON.stringify(payload));
			} catch {
				// best effort
			}
		},
	};
}
