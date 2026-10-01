/**
 * Contributions: file records → per-file `FileContribution`s, maintained incrementally.
 *
 * `ContributionTracker` keeps, per file, a small state record (never the counted messages themselves) plus
 * global tables: hash → holders (ownership = first holder in canonical order), reporting-provider counts,
 * session → files, the scanned-session index and the nested tool-usage dependency registry. `update()`
 * touches only what a change can influence and reports the minimal `ContributionDelta`.
 * `buildContributions` below stays as the from-scratch reference (the legacy rules).
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	buildScannedSessionIndex,
	childSessionScanned,
	classifyMiss,
	EXCLUDED_PROVIDERS,
	projectLabelFromCwd,
	resolvedToolChildIdentities,
	toolChildIdentity,
	toolUsageMessages,
} from "../data.ts";
import type { MessageMeta, ScannedSessionIndex, SessionMessage, ToolUsageRecord } from "../data.ts";
import { canonicalProvider, pricedDevinCost } from "../sources.ts";
import { compareCanonical } from "./types.ts";
import type { ContributionDelta, ContributionUpdate, CountedMessage, FileContribution, FileRecord } from "./types.ts";

/** Dedupe key; equality semantics identical to the legacy `${source}:${sourceId}:${timestamp}:${fp}` hash
 * (source has two values, so a one-letter prefix is injective). */
function hashOf(m: SessionMessage): string {
	const fp = m.input + m.output + m.cacheRead + m.cacheWrite;
	const s = m.source === "assistant" ? "a" : "x";
	return m.sourceId !== "" ? `${s}:${m.sourceId}:${m.timestamp}:${fp}` : `${s}:${m.timestamp}:${fp}`;
}

function hashesOf(messages: readonly SessionMessage[], tool: readonly SessionMessage[]): string[] {
	const out: string[] = new Array(messages.length + tool.length);
	let k = 0;
	for (const m of messages) out[k++] = hashOf(m);
	for (const m of tool) out[k++] = hashOf(m);
	return out;
}

function sameMessage(a: SessionMessage, b: SessionMessage): boolean {
	const ra = a as unknown as Record<string, unknown>;
	const rb = b as unknown as Record<string, unknown>;
	const ka = Object.keys(ra);
	if (ka.length !== Object.keys(rb).length) return false;
	for (const k of ka) if (ra[k] !== rb[k]) return false;
	return true;
}

function sameMessages(a: readonly SessionMessage[], b: readonly SessionMessage[], length = a.length): boolean {
	if (a === b) return true;
	if (a.length < length || b.length < length) return false;
	for (let i = 0; i < length; i++) if (!sameMessage(a[i]!, b[i]!)) return false;
	return true;
}

/** Per-file bookkeeping. Counted messages are NOT retained (the ledger owns them). */
class FileState {
	readonly path: string;
	readonly kind: FileRecord["kind"];
	record: FileRecord;
	sessionId = "";
	sessioned = false;
	/** Nested tool-usage auxiliary messages (depend on which session files exist). */
	toolMsgs: SessionMessage[] = [];
	/** Identities of tool children resolved through the scanned index (all files, as legacy). */
	resolvedIds: string[] | null = null;
	depKeys: string[] | null = null;
	identKeys: string[] | null = null;
	reportCounts: Map<string, number> | null = null;
	/** The file holds a duplicate hash itself (rebuilds then need a local seen-set). */
	hasDup = false;
	hasAsst = false;
	/** Counted messages the ledger currently holds for this file. */
	emitted = 0;
	// Adjacency state after the last raw assistant message.
	hasPrev = false;
	pTs = 0;
	pCtx = 0;
	pProv = "";
	pModel = "";

	constructor(record: FileRecord) {
		this.path = record.path;
		this.kind = record.kind;
		this.record = record;
	}
}

interface Pending {
	file: FileState;
	isNew: boolean;
	removed: boolean;
	oldRecord: FileRecord;
	oldTool: SessionMessage[];
	oldSessioned: boolean;
	hasAsstBefore: boolean;
	/** "append": only records after `messagesFrom` are new (also covers tool-only changes). */
	mode: "append" | "full";
	messagesFrom: number;
	toolChanged: boolean;
	hashes: string[] | null;
	newItems: CountedMessage[] | null;
	newFirstAsst: number;
}

interface Rebuilt {
	counted: CountedMessage[];
	firstAsst: number;
}

const DUP = 0;
const OWNED = 1;
const HELD = 2;

export class ContributionTracker {
	private files = new Map<string, FileState>();
	private holders = new Map<string, FileState | FileState[]>();
	private displaced: FileState | null = null;
	private repCounts = new Map<string, number>();
	private reporting = new Set<string>();
	private sessionFiles = new Map<string, Set<FileState>>();
	private startOf = new Map<string, FileState>();
	private scanned: ScannedSessionIndex = { paths: new Set(), fileCountByDir: new Map() };
	private resolvedCounts = new Map<string, number>();
	private resolvedSet = new Set<string>();
	private depFiles = new Map<string, Set<FileState>>();
	private identFiles = new Map<string, Set<FileState>>();
	// Per-update scratch.
	private batch: Batch | null = null;

	/** Records currently tracked (read-only view, for the service). */
	get size(): number {
		return this.files.size;
	}

	update(update: ContributionUpdate): ContributionDelta {
		const b: Batch = {
			pendings: new Map(),
			changedKeys: new Set(),
			needsTools: new Set(),
			identInit: new Map(),
			repInit: new Map(),
			dirty: new Set(),
			touched: new Set(),
		};
		this.batch = b;
		try {
			return this.run(update, b);
		} finally {
			this.batch = null;
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Phases
	// ---------------------------------------------------------------------------------------------

	private run(update: ContributionUpdate, b: Batch): ContributionDelta {
		// P1: record bookkeeping (everything except ownership).
		for (const path of update.removed) {
			const f = this.files.get(path);
			if (!f) continue;
			this.pend(f, b).removed = true;
			this.files.delete(path);
			this.detach(f, b);
		}
		for (const outcome of update.upserts) this.upsert(outcome.record, outcome.change, b);

		// P2: nested tool-usage messages of every file whose inputs changed.
		this.refreshTools(b);

		// P3: ownership + pending appends.
		const removedList = new Set<string>();
		for (const p of b.pendings.values()) this.own(p, b, removedList);

		// P4: did the cache-reporting provider set change?
		let reset = false;
		for (const [provider, was] of b.repInit) if ((this.repCounts.get(provider) ?? 0) > 0 !== was) reset = true;
		if (reset) {
			for (const f of this.files.values()) if (f.sessioned) b.dirty.add(f);
			for (const id of this.sessionFiles.keys()) b.touched.add(id);
		}

		// P5: rebuild dirty files, settle session starts, emit.
		const rebuilt = new Map<FileState, Rebuilt>();
		for (const f of b.dirty) {
			if (this.files.get(f.path) !== f || !f.sessioned) continue;
			const had = f.hasAsst;
			rebuilt.set(f, this.rebuild(f, b.pendings.get(f)?.hashes ?? null));
			if (f.hasAsst !== had) b.touched.add(f.sessionId);
		}
		for (const p of b.pendings.values()) if (p.removed || p.oldSessioned) b.touched.add(p.oldRecord.parsed.sessionId);
		this.settleSessionStarts(b, rebuilt);
		for (const [f, r] of rebuilt) {
			if (r.firstAsst >= 0 && this.startOf.get(f.sessionId) === f) r.counted[r.firstAsst]!.meta.isSessionStart = true;
		}

		const delta: ContributionDelta = { reset, replaced: [], appended: [], removed: [] };
		for (const [f, r] of rebuilt) {
			if (r.counted.length === 0) {
				if (f.emitted > 0 && !reset) removedList.add(f.path);
				f.emitted = 0;
			} else {
				delta.replaced.push({ path: f.path, kind: f.kind, sessionId: f.sessionId, project: projectLabelFromCwd(f.record.parsed.cwd), counted: r.counted });
				f.emitted = r.counted.length;
			}
		}
		if (reset) {
			delta.replaced.sort(compareCanonical);
			return delta;
		}
		for (const p of b.pendings.values()) {
			const f = p.file;
			if (p.removed || rebuilt.has(f) || !p.newItems || p.newItems.length === 0 || this.files.get(f.path) !== f) continue;
			delta.appended.push({ path: f.path, counted: p.newItems });
			f.emitted += p.newItems.length;
		}
		const replacedPaths = new Set(delta.replaced.map((c) => c.path));
		for (const path of removedList) if (!replacedPaths.has(path)) delta.removed.push(path);
		return delta;
	}

	private pend(f: FileState, b: Batch): Pending {
		let p = b.pendings.get(f);
		if (!p) {
			p = {
				file: f,
				isNew: false,
				removed: false,
				oldRecord: f.record,
				oldTool: f.toolMsgs,
				oldSessioned: f.sessioned,
				hasAsstBefore: f.hasAsst,
				mode: "append",
				messagesFrom: f.record.parsed.messages.length,
				toolChanged: false,
				hashes: null,
				newItems: null,
				newFirstAsst: -1,
			};
			b.pendings.set(f, p);
		}
		return p;
	}

	private upsert(record: FileRecord, change: { type: string; messagesFrom?: number; toolUsagesFrom?: number }, b: Batch): void {
		let f = this.files.get(record.path);
		if (!f) {
			f = new FileState(record);
			this.files.set(record.path, f);
			const p = this.pend(f, b);
			p.isNew = true;
			p.mode = "full";
			p.oldSessioned = false;
			this.attach(f, b);
			return;
		}
		const seen = b.pendings.has(f);
		const p = this.pend(f, b);
		const old = f.record.parsed;
		const nu = record.parsed;
		const same = nu.sessionId === old.sessionId && f.sessioned && !seen;
		if (same && change.type === "none" && nu.messages.length === old.messages.length && nu.toolUsages.length === old.toolUsages.length) {
			f.record = record;
			return;
		}
		if (same && change.type === "append" && change.messagesFrom === old.messages.length && change.toolUsagesFrom === old.toolUsages.length && nu.messages.length >= old.messages.length) {
			f.record = record;
			this.addReporting(f, nu.messages, old.messages.length, b);
			if (nu.toolUsages.length !== old.toolUsages.length) {
				this.unregisterDeps(f);
				this.registerDeps(f);
				b.needsTools.add(f);
			}
			return;
		}
		p.mode = "full";
		this.detach(f, b);
		f.record = record;
		this.attach(f, b);
	}

	/** Remove a file's record-derived contributions to the global tables (keeps `f.record`/`toolMsgs`). */
	private detach(f: FileState, b: Batch): void {
		this.unregisterDeps(f);
		if (f.resolvedIds) for (const id of f.resolvedIds) this.adjustResolved(id, -1, b);
		f.resolvedIds = null;
		if (f.reportCounts) for (const [prov, n] of f.reportCounts) this.adjustReporting(prov, -n, b);
		f.reportCounts = null;
		if (f.sessioned) {
			const rp = resolve(f.path);
			const dir = dirname(rp);
			this.scanned.paths.delete(rp);
			const left = (this.scanned.fileCountByDir.get(dir) ?? 1) - 1;
			if (left > 0) this.scanned.fileCountByDir.set(dir, left);
			else this.scanned.fileCountByDir.delete(dir);
			b.changedKeys.add("p" + rp);
			b.changedKeys.add("d" + dir);
			const set = this.sessionFiles.get(f.sessionId);
			if (set) {
				set.delete(f);
				if (set.size === 0) this.sessionFiles.delete(f.sessionId);
			}
			b.touched.add(f.sessionId);
			f.sessioned = false;
		}
	}

	/** Register `f.record` in the global tables. */
	private attach(f: FileState, b: Batch): void {
		const parsed = f.record.parsed;
		f.sessionId = parsed.sessionId;
		f.sessioned = parsed.sessionId !== "";
		this.addReporting(f, parsed.messages, 0, b);
		this.registerDeps(f);
		if (parsed.toolUsages.length > 0 || f.toolMsgs.length > 0) b.needsTools.add(f);
		if (f.sessioned) {
			const rp = resolve(f.path);
			const dir = dirname(rp);
			this.scanned.paths.add(rp);
			this.scanned.fileCountByDir.set(dir, (this.scanned.fileCountByDir.get(dir) ?? 0) + 1);
			b.changedKeys.add("p" + rp);
			b.changedKeys.add("d" + dir);
			let set = this.sessionFiles.get(f.sessionId);
			if (!set) this.sessionFiles.set(f.sessionId, (set = new Set()));
			set.add(f);
			b.touched.add(f.sessionId);
		}
	}

	private addReporting(f: FileState, messages: readonly SessionMessage[], from: number, b: Batch): void {
		for (let i = from; i < messages.length; i++) {
			const m = messages[i]!;
			if (m.cacheRead > 0 || m.cacheWrite > 0) {
				const prov = canonicalProvider(m.provider);
				if (!f.reportCounts) f.reportCounts = new Map();
				f.reportCounts.set(prov, (f.reportCounts.get(prov) ?? 0) + 1);
				this.adjustReporting(prov, 1, b);
			}
		}
	}

	private adjustReporting(provider: string, delta: number, b: Batch): void {
		const before = this.repCounts.get(provider) ?? 0;
		if (!b.repInit.has(provider)) b.repInit.set(provider, before > 0);
		const after = before + delta;
		if (after > 0) {
			this.repCounts.set(provider, after);
			this.reporting.add(provider);
		} else {
			this.repCounts.delete(provider);
			this.reporting.delete(provider);
		}
	}

	private adjustResolved(id: string, delta: number, b: Batch): void {
		const before = this.resolvedCounts.get(id) ?? 0;
		if (!b.identInit.has(id)) b.identInit.set(id, before > 0);
		const after = before + delta;
		if (after > 0) {
			this.resolvedCounts.set(id, after);
			this.resolvedSet.add(id);
		} else {
			this.resolvedCounts.delete(id);
			this.resolvedSet.delete(id);
		}
	}

	// --- nested tool-usage dependencies ----------------------------------------------------------

	private registerDeps(f: FileState): void {
		const tools = f.record.parsed.toolUsages;
		let keys: string[] | null = null;
		let idents: string[] | null = null;
		for (const tool of tools) {
			if (tool.children.length === 0) continue;
			keys ??= [];
			const parentDir = dirname(f.path);
			if (tool.runId) {
				for (const child of tool.children) {
					const runDir = resolve(parentDir, basename(f.path, ".jsonl"), tool.runId, `run-${child.resultIndex}`);
					keys.push("p" + join(runDir, "session.jsonl"), "d" + runDir);
				}
			}
			for (const child of tool.children) {
				if (child.sessionFile) keys.push("p" + (isAbsolute(child.sessionFile) ? resolve(child.sessionFile) : resolve(parentDir, child.sessionFile)));
				if (tool.sourceId) (idents ??= []).push(toolChildIdentity(tool, child));
			}
		}
		f.depKeys = keys;
		f.identKeys = idents;
		if (keys) for (const k of keys) this.addTo(this.depFiles, k, f);
		if (idents) for (const k of idents) this.addTo(this.identFiles, k, f);
	}

	private unregisterDeps(f: FileState): void {
		if (f.depKeys) for (const k of f.depKeys) this.removeFrom(this.depFiles, k, f);
		if (f.identKeys) for (const k of f.identKeys) this.removeFrom(this.identFiles, k, f);
		f.depKeys = null;
		f.identKeys = null;
	}

	private addTo(map: Map<string, Set<FileState>>, key: string, f: FileState): void {
		let set = map.get(key);
		if (!set) map.set(key, (set = new Set()));
		set.add(f);
	}

	private removeFrom(map: Map<string, Set<FileState>>, key: string, f: FileState): void {
		const set = map.get(key);
		if (!set) return;
		set.delete(f);
		if (set.size === 0) map.delete(key);
	}

	private computeResolvedIds(f: FileState): string[] | null {
		let out: string[] | null = null;
		for (const tool of f.record.parsed.toolUsages) {
			if (!tool.sourceId) continue;
			for (const child of tool.children) {
				if (childSessionScanned(f.path, tool, child, this.scanned)) (out ??= []).push(toolChildIdentity(tool, child));
			}
		}
		return out;
	}

	private refreshTools(b: Batch): void {
		const files = new Set<FileState>();
		for (const k of b.changedKeys) {
			const set = this.depFiles.get(k);
			if (set) for (const f of set) files.add(f);
		}
		for (const f of b.needsTools) if (this.files.get(f.path) === f) files.add(f);
		// Resolved child identities of every affected file (all files count, sessioned or not).
		for (const f of files) {
			if (f.resolvedIds) for (const id of f.resolvedIds) this.adjustResolved(id, -1, b);
			f.resolvedIds = this.computeResolvedIds(f);
			if (f.resolvedIds) for (const id of f.resolvedIds) this.adjustResolved(id, 1, b);
		}
		for (const [id, was] of b.identInit) {
			if ((this.resolvedCounts.get(id) ?? 0) > 0 === was) continue;
			const set = this.identFiles.get(id);
			if (set) for (const f of set) files.add(f);
		}
		for (const f of files) {
			const next: SessionMessage[] = [];
			if (f.sessioned) {
				for (const t of f.record.parsed.toolUsages) for (const m of toolUsageMessages(f.path, t, this.scanned, this.resolvedSet)) next.push(m);
			}
			if (sameMessages(f.toolMsgs, next) && f.toolMsgs.length === next.length) continue;
			const p = this.pend(f, b);
			p.toolChanged = true;
			f.toolMsgs = next;
		}
	}

	// --- ownership --------------------------------------------------------------------------------

	private hold(h: string, f: FileState): number {
		this.displaced = null;
		const e = this.holders.get(h);
		if (e === undefined) {
			this.holders.set(h, f);
			return OWNED;
		}
		if (Array.isArray(e)) {
			if (e.includes(f)) return DUP;
			let i = 0;
			while (i < e.length && compareCanonical(e[i]!, f) < 0) i++;
			e.splice(i, 0, f);
			if (i === 0) {
				this.displaced = e[1]!;
				return OWNED;
			}
			return HELD;
		}
		if (e === f) return DUP;
		if (compareCanonical(f, e) < 0) {
			this.holders.set(h, [f, e]);
			this.displaced = e;
			return OWNED;
		}
		this.holders.set(h, [e, f]);
		return HELD;
	}

	private unhold(h: string, f: FileState, b: Batch): void {
		const e = this.holders.get(h);
		if (e === undefined) return;
		if (!Array.isArray(e)) {
			if (e === f) this.holders.delete(h);
			return;
		}
		const i = e.indexOf(f);
		if (i === -1) return;
		e.splice(i, 1);
		if (e.length === 1) this.holders.set(h, e[0]!);
		if (i === 0) b.dirty.add(e[0]!);
	}

	private own(p: Pending, b: Batch, removedList: Set<string>): void {
		const f = p.file;
		const oldHashes = () => hashesOf(p.oldRecord.parsed.messages, p.oldTool);
		if (p.removed) {
			if (p.oldSessioned) for (const h of oldHashes()) this.unhold(h, f, b);
			if (f.emitted > 0) removedList.add(f.path);
			f.emitted = 0;
			return;
		}
		if (!f.sessioned) {
			if (p.oldSessioned) for (const h of oldHashes()) this.unhold(h, f, b);
			if (f.emitted > 0) removedList.add(f.path);
			f.emitted = 0;
			f.hasAsst = false;
			f.hasDup = false;
			return;
		}
		const messages = f.record.parsed.messages;
		if (!p.isNew && p.oldSessioned && p.mode === "append" && !p.toolChanged && messages.length === p.messagesFrom) return; // size/mtime only
		if (!p.isNew && p.oldSessioned && p.mode === "append" && f.emitted > 0) {
			const oldT = p.oldTool;
			const newT = f.toolMsgs;
			const newMsgs = messages.length - p.messagesFrom;
			if (newT.length >= oldT.length && (!p.toolChanged || sameMessages(oldT, newT, oldT.length)) && (newMsgs === 0 || oldT.length === 0)) {
				const out: CountedMessage[] = [];
				const total = newMsgs + (newT.length - oldT.length);
				for (let k = 0; k < total; k++) {
					const original = k < newMsgs ? messages[p.messagesFrom + k]! : newT[oldT.length + k - newMsgs]!;
					const r = this.hold(hashOf(original), f);
					if (this.displaced && this.displaced !== f) b.dirty.add(this.displaced);
					if (r === DUP) f.hasDup = true;
					const entry = this.step(f, original, r === OWNED, out);
					if (entry && entry.msg.source === "assistant" && p.newFirstAsst < 0) p.newFirstAsst = out.length - 1;
				}
				p.newItems = out;
				if (p.newFirstAsst >= 0 && !f.hasAsst) {
					f.hasAsst = true;
					b.touched.add(f.sessionId);
				}
				return;
			}
		}
		// General path: diff the held hashes, then the file is rebuilt.
		const hashes = hashesOf(messages, f.toolMsgs);
		if (p.isNew || !p.oldSessioned) {
			f.hasDup = false;
			for (const h of hashes) {
				const r = this.hold(h, f);
				if (r === DUP) f.hasDup = true;
				else if (this.displaced && this.displaced !== f) b.dirty.add(this.displaced);
			}
		} else {
			const oldSet = new Set(oldHashes());
			const newSet = new Set(hashes);
			f.hasDup = newSet.size < hashes.length;
			for (const h of oldSet) if (!newSet.has(h)) this.unhold(h, f, b);
			for (const h of newSet) {
				if (oldSet.has(h)) continue;
				this.hold(h, f);
				if (this.displaced && this.displaced !== f) b.dirty.add(this.displaced);
			}
		}
		p.hashes = hashes;
		b.dirty.add(f);
	}

	// --- building counted messages ---------------------------------------------------------------

	/** Process one raw message in file order: advances the adjacency state and, when `own`, counts it. */
	private step(f: FileState, original: SessionMessage, own: boolean, out: CountedMessage[]): CountedMessage | null {
		const isAsst = original.source === "assistant";
		const provider = canonicalProvider(original.provider);
		let entry: CountedMessage | null = null;
		if (own) {
			const m: SessionMessage = { ...original, provider };
			if (isAsst) m.cost = pricedDevinCost(provider, m.model, m);
			const hasP = isAsst && f.hasPrev;
			const meta: MessageMeta = {
				gapMs: hasP && f.pTs > 0 && m.timestamp > 0 ? m.timestamp - f.pTs : -1,
				prevCtx: hasP ? f.pCtx : 0,
				modelSwitched: hasP && (f.pProv !== provider || f.pModel !== m.model),
				isSessionStart: false,
			};
			entry = { msg: m, meta, miss: EXCLUDED_PROVIDERS.has(provider) ? null : classifyMiss(m, meta, this.reporting) };
			out.push(entry);
		}
		if (isAsst) {
			f.hasPrev = true;
			f.pTs = original.timestamp;
			f.pCtx = original.input + original.cacheRead + original.cacheWrite;
			f.pProv = provider;
			f.pModel = original.model;
		}
		return entry;
	}

	private rebuild(f: FileState, hashes: string[] | null): Rebuilt {
		const messages = f.record.parsed.messages;
		const tool = f.toolMsgs;
		const n = messages.length + tool.length;
		const seen = f.hasDup ? new Set<string>() : null;
		f.hasPrev = false;
		const counted: CountedMessage[] = [];
		let firstAsst = -1;
		for (let i = 0; i < n; i++) {
			const original = i < messages.length ? messages[i]! : tool[i - messages.length]!;
			const h = hashes ? hashes[i]! : hashOf(original);
			const e = this.holders.get(h);
			let own = e === f || (Array.isArray(e) && e[0] === f);
			if (own && seen) {
				if (seen.has(h)) own = false;
				else seen.add(h);
			}
			const entry = this.step(f, original, own, counted);
			if (entry && firstAsst === -1 && entry.msg.source === "assistant") firstAsst = counted.length - 1;
		}
		f.hasAsst = firstAsst !== -1;
		return { counted, firstAsst };
	}

	private settleSessionStarts(b: Batch, rebuilt: Map<FileState, Rebuilt>): void {
		for (const id of b.touched) {
			const cands = this.sessionFiles.get(id);
			let winner: FileState | null = null;
			if (cands) for (const c of cands) if (c.hasAsst && (winner === null || compareCanonical(c, winner) < 0)) winner = c;
			const prev = this.startOf.get(id) ?? null;
			if (winner !== prev) {
				if (prev && this.files.get(prev.path) === prev && prev.sessioned && prev.sessionId === id && !rebuilt.has(prev)) this.forceRebuild(prev, b, rebuilt);
				if (winner && !rebuilt.has(winner)) {
					const p = b.pendings.get(winner);
					if (p && p.newItems && p.newFirstAsst >= 0 && !p.hasAsstBefore) p.newItems[p.newFirstAsst]!.meta.isSessionStart = true;
					else this.forceRebuild(winner, b, rebuilt);
				}
			}
			if (winner) this.startOf.set(id, winner);
			else this.startOf.delete(id);
		}
	}

	private forceRebuild(f: FileState, b: Batch, rebuilt: Map<FileState, Rebuilt>): void {
		const p = b.pendings.get(f);
		if (p) p.newItems = null;
		const hasAsst = f.hasAsst;
		rebuilt.set(f, this.rebuild(f, p?.hashes ?? null));
		f.hasAsst = hasAsst;
	}
}

interface Batch {
	pendings: Map<FileState, Pending>;
	changedKeys: Set<string>;
	needsTools: Set<FileState>;
	identInit: Map<string, boolean>;
	repInit: Map<string, boolean>;
	dirty: Set<FileState>;
	touched: Set<string>;
}

/**
 * Legacy-equivalent contributions for a full set of records: canonical order, cross-file dedupe by message
 * hash, adjacency meta in raw file order, first-assistant session starts, miss classification against the
 * cache-reporting provider set, nested tool-usage auxiliary messages. Messages are copied, never mutated.
 */
export function buildContributions(records: Map<string, FileRecord>): FileContribution[] {
	const ordered = [...records.values()].sort(compareCanonical);
	const scanned = buildScannedSessionIndex(records);
	const resolvedChildren = resolvedToolChildIdentities(records, scanned);
	const reporting = new Set<string>();
	for (const r of ordered) for (const m of r.parsed.messages) if (m.cacheRead > 0 || m.cacheWrite > 0) reporting.add(canonicalProvider(m.provider));
	const seenHashes = new Set<string>();
	const seenSessions = new Set<string>();
	const out: FileContribution[] = [];
	for (const r of ordered) {
		if (!r.parsed.sessionId) continue;
		const tool = r.parsed.toolUsages.flatMap((t) => toolUsageMessages(r.path, t, scanned, resolvedChildren));
		const raw = tool.length > 0 ? [...r.parsed.messages, ...tool] : r.parsed.messages;
		const counted: CountedMessage[] = [];
		let previousAssistant: SessionMessage | null = null;
		for (const original of raw) {
			const m: SessionMessage = { ...original, provider: canonicalProvider(original.provider) };
			if (m.source === "assistant") m.cost = pricedDevinCost(m.provider, m.model, m);
			const prev = m.source === "assistant" ? previousAssistant : null;
			if (m.source === "assistant") previousAssistant = m;
			const fp = m.input + m.output + m.cacheRead + m.cacheWrite;
			const hash = m.sourceId !== "" ? `${m.source}:${m.sourceId}:${m.timestamp}:${fp}` : `${m.source}:${m.timestamp}:${fp}`;
			if (seenHashes.has(hash)) continue;
			seenHashes.add(hash);
			const meta: MessageMeta = {
				gapMs: prev && prev.timestamp > 0 && m.timestamp > 0 ? m.timestamp - prev.timestamp : -1,
				prevCtx: prev ? prev.input + prev.cacheRead + prev.cacheWrite : 0,
				modelSwitched: prev !== null && (prev.provider !== m.provider || prev.model !== m.model),
				isSessionStart: false,
			};
			counted.push({ msg: m, meta, miss: null });
		}
		if (counted.length === 0) continue;
		const first = counted.findIndex((c) => c.msg.source === "assistant");
		if (first !== -1 && !seenSessions.has(r.parsed.sessionId)) {
			seenSessions.add(r.parsed.sessionId);
			counted[first]!.meta.isSessionStart = true;
		}
		for (const c of counted) {
			if (EXCLUDED_PROVIDERS.has(c.msg.provider)) continue;
			c.miss = classifyMiss(c.msg, c.meta, reporting);
		}
		out.push({ path: r.path, kind: r.kind, sessionId: r.parsed.sessionId, project: projectLabelFromCwd(r.parsed.cwd), counted });
	}
	return out;
}
