/**
 * Discovery: every usage source file with size/mtime, in canonical order.
 *
 * Same inclusion rules as the legacy walkers in sources.ts (regular files only — symlinks are not followed
 * as entries; unreadable directories are skipped; `.jsonl` for pi/claude/codex, `updates.jsonl` for grok,
 * `msg_*.json` under `storage/message` for opencode; the first kind to claim a path wins), but with a
 * parallel recursive readdir and high-concurrency stat. `Discoverer` additionally keeps directory listings
 * across calls, keyed by directory mtime, for the long-lived service.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedUsageSources, UsageFileKind } from "../sources.ts";
import { compareCanonical } from "./types.ts";
import type { DiscoveredFile } from "./types.ts";

export interface DiscoverOptions {
	sessionsDir: string;
	sources: ResolvedUsageSources;
	signal?: AbortSignal;
}

const CONCURRENCY = 64;
/** A listing made this soon after the directory's mtime may have missed a same-tick change: not trusted. */
const RACY_WINDOW_MS = 2000;

type Matcher = (name: string) => boolean;

interface Scan {
	root: string;
	kind: UsageFileKind;
	filterId: string;
	match: Matcher;
}

const jsonl: Matcher = (name) => name.endsWith(".jsonl");
const updates: Matcher = (name) => name === "updates.jsonl";
const opencodeMsg: Matcher = (name) => name.startsWith("msg_") && name.endsWith(".json");

function openCodeMessageRoot(root: string): string {
	const normalized = root.replace(/\/+$/, "");
	if (normalized.endsWith("/storage/message")) return normalized;
	if (normalized.endsWith("/storage")) return join(normalized, "message");
	return join(normalized, "storage", "message");
}

function planScans(sessionsDir: string, sources: ResolvedUsageSources): Scan[] {
	const scans: Scan[] = [{ root: sessionsDir, kind: "pi", filterId: "jsonl", match: jsonl }];
	if (sources.claudeCode.enabled) for (const root of sources.claudeCode.roots) scans.push({ root, kind: "claude-code", filterId: "jsonl", match: jsonl });
	if (sources.codexCli.enabled) for (const root of sources.codexCli.roots) scans.push({ root, kind: "codex-cli", filterId: "jsonl", match: jsonl });
	if (sources.grokBuild.enabled) for (const root of sources.grokBuild.roots) scans.push({ root, kind: "grok-build", filterId: "updates", match: updates });
	if (sources.opencodeGo.enabled) {
		for (const root of sources.opencodeGo.roots) scans.push({ root: openCodeMessageRoot(root), kind: "opencode-go", filterId: "opencode", match: opencodeMsg });
	}
	return scans;
}

/** Counting semaphore bounding concurrent fs calls. */
class Gate {
	private active = 0;
	private waiters: Array<() => void> = [];
	private readonly limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve)); // slot handed over
		else this.active++;
		try {
			return await fn();
		} finally {
			const waiter = this.waiters.shift();
			if (waiter) waiter();
			else this.active--;
		}
	}
}

interface DirListing {
	mtimeMs: number;
	listedAt: number;
	files: string[];
	dirs: string[];
}

type ListingCache = Map<string, DirListing>;

async function listDirectory(dir: string, match: Matcher, gate: Gate, cache: ListingCache | null, cacheKey: string): Promise<DirListing | null> {
	if (cache) {
		const hit = cache.get(cacheKey);
		if (hit) {
			try {
				const st = await gate.run(() => stat(dir));
				if (st.mtimeMs === hit.mtimeMs && hit.listedAt - hit.mtimeMs >= RACY_WINDOW_MS) return hit;
			} catch {
				cache.delete(cacheKey);
				return null;
			}
		}
	}
	try {
		const listedAt = Date.now();
		let mtimeMs = 0;
		if (cache) mtimeMs = (await gate.run(() => stat(dir))).mtimeMs;
		const entries = await gate.run(() => readdir(dir, { withFileTypes: true }));
		const files: string[] = [];
		const dirs: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) dirs.push(entry.name);
			else if (entry.isFile() && match(entry.name)) files.push(entry.name);
		}
		const listing: DirListing = { mtimeMs, listedAt, files, dirs };
		if (cache) cache.set(cacheKey, listing);
		return listing;
	} catch {
		cache?.delete(cacheKey);
		return null; // unreadable → skipped, as legacy
	}
}

async function walk(
	dir: string,
	scan: Scan,
	gate: Gate,
	cache: ListingCache | null,
	signal: AbortSignal | undefined,
	out: string[],
	seenDirs: Set<string> | null,
	onFile: (path: string) => void
): Promise<void> {
	if (signal?.aborted) return;
	const key = `${scan.filterId}\0${dir}`;
	seenDirs?.add(key);
	const listing = await listDirectory(dir, scan.match, gate, cache, key);
	if (!listing) return;
	for (const name of listing.files) {
		const path = join(dir, name);
		out.push(path);
		onFile(path);
	}
	await Promise.all(listing.dirs.map((name) => walk(join(dir, name), scan, gate, cache, signal, out, seenDirs, onFile)));
}

async function discover(options: DiscoverOptions, cache: ListingCache | null): Promise<DiscoveredFile[] | null> {
	const { sessionsDir, sources, signal } = options;
	const gate = new Gate(CONCURRENCY);
	const scans = planScans(sessionsDir, sources);
	const seenDirs = cache ? new Set<string>() : null;
	const lists = scans.map(() => [] as string[]);
	// stat each file as soon as it is listed (overlapping the walk); every path is stat'ed once.
	const stats = new Map<string, Promise<{ size: number; mtimeMs: number } | null>>();
	const onFile = (path: string) => {
		if (stats.has(path)) return;
		stats.set(
			path,
			gate.run(() => stat(path)).then(
				(st) => ({ size: st.size, mtimeMs: st.mtimeMs }),
				() => null // vanished
			)
		);
	};
	await Promise.all(scans.map((scan, i) => walk(scan.root, scan, gate, cache, signal, lists[i]!, seenDirs, onFile)));
	if (signal?.aborted) {
		await Promise.all(stats.values());
		return null;
	}
	if (cache && seenDirs) for (const key of cache.keys()) if (!seenDirs.has(key)) cache.delete(key);

	const seen = new Map<string, UsageFileKind>();
	scans.forEach((scan, i) => {
		for (const p of lists[i]!) if (!seen.has(p)) seen.set(p, scan.kind);
	});

	const out: DiscoveredFile[] = [];
	await Promise.all(
		[...seen].map(async ([path, kind]) => {
			const st = await stats.get(path)!;
			if (st) out.push({ path, kind, size: st.size, mtimeMs: st.mtimeMs });
		})
	);
	if (signal?.aborted) return null;
	return out.sort(compareCanonical);
}

/** Every source file with its size/mtime, in canonical order; null when aborted. Vanished files are skipped. */
export function discoverFiles(options: DiscoverOptions): Promise<DiscoveredFile[] | null> {
	return discover(options, null);
}

/** Long-lived discovery: directory listings are reused while the directory mtime is unchanged (every file
 * is still stat'ed). Calls must not overlap with different options; overlapping identical calls are fine. */
export class Discoverer {
	private readonly cache: ListingCache = new Map();
	/** Directory listings served from the cache / (re)read by the last call — for tests and diagnostics. */
	hits = 0;
	misses = 0;

	async discover(options: DiscoverOptions): Promise<DiscoveredFile[] | null> {
		const counting = new Map(this.cache);
		const result = await discover(options, this.cache);
		for (const [key, listing] of this.cache) {
			if (counting.get(key) === listing) this.hits++;
			else this.misses++;
		}
		return result;
	}
}
