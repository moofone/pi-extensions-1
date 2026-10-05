/**
 * Pure aggregation of normalized workflow records into per-day metrics, plus fixed neutral prose.
 * No I/O, no transcript bodies, no model calls. Unknown measurements stay unknown, never zero.
 */
import { createHash } from "node:crypto";
import type {
	WorkflowCall, WorkflowDay, WorkflowEvidence, WorkflowInput, WorkflowInsight, WorkflowKind,
	WorkflowMetric, WorkflowRecord, WorkflowRoleDay, WorkflowSnapshot, WorkflowUsage,
} from "./types.ts";

const MAX_EVIDENCE_PER_KIND_DAY = 3;
const MAX_EVIDENCE_TOTAL = 256;
/** Duplicate-delivery candidate window, in records after the notification. */
const DELIVERY_WINDOW = 64;
const MAX_TREE_NODES = 4096;
const KINDS = new Set(["session", "metadata", "context-edit", "system", "user", "notice", "assistant", "tool-result", "compaction", "opaque"]);
const LENS_ORDER: WorkflowKind[] = ["wakes-errors", "duplicate-delivery", "missing-handoff", "verification", "chronology", "startup", "roles", "compaction", "telemetry"];

// ---------------------------------------------------------------- small helpers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
/** A counter is a finite, non-negative number; anything else is unknown. */
const counter = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local calendar date; unusable timestamps (missing, nonfinite, non-positive) have no day. */
function localDay(at: unknown): string | undefined {
	if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return undefined;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface Rec {
	r: WorkflowRecord;
	/** Copy of an earlier-captured record (resumed/forked history); never charged again. */
	dup: boolean;
	day?: string;
	session: string;
	/** Bounded content identity ("" when the record has no id and so can never be a copy). */
	key: string;
}

function usageKey(u: unknown): string {
	if (!isObj(u)) return "";
	return [u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning, u.cost].map((v) => (typeof v === "number" ? String(v) : "")).join(",");
}

function callsKey(calls: unknown): string {
	if (!Array.isArray(calls)) return "";
	return calls.slice(0, 64).map((c) => (isObj(c) ? [c.id, c.name, c.test, c.filtered, c.forcedExit, c.mutation, c.testNamedPath, c.baselineRead].join(":") : "")).join("|");
}

/** Content identity of one record, excluding its physical line and parent link (forks rewrite parents). */
function recordKey(r: WorkflowRecord): string {
	return createHash("sha256").update(JSON.stringify([r.id, r.kind, r.at ?? "", r.role ?? "", r.stop ?? "", r.textHash ?? "", r.textBytes ?? "", r.deliveryHash ?? "", r.deliveryBytes ?? "",
		r.wakeHash ?? "", r.resultFor ?? "", r.exitCode ?? "", usageKey(r.usage), callsKey(r.calls)])).digest("hex");
}

// ---------------------------------------------------------------- accumulation

class Acc {
	days = new Map<string, { metrics: Partial<Record<WorkflowMetric, number>>; evidence: WorkflowEvidence[]; perKind: Map<WorkflowKind, number> }>();
	roles = new Map<string, WorkflowRoleDay>();

	private day(day: string) {
		let d = this.days.get(day);
		if (!d) this.days.set(day, (d = { metrics: {}, evidence: [], perKind: new Map() }));
		return d;
	}

	/** Adds n (default 1) to a metric. n=0 only records that the family was observed. */
	add(day: string | undefined, metric: WorkflowMetric, n = 1): void {
		if (!day) return;
		const m = this.day(day).metrics;
		m[metric] = (m[metric] ?? 0) + n;
	}

	ensure(day: string | undefined, ...metrics: WorkflowMetric[]): void {
		for (const m of metrics) this.add(day, m, 0);
	}

	evidence(day: string | undefined, kind: WorkflowKind, session: string, line: number, relatedLine?: number): void {
		if (!day) return;
		const d = this.day(day);
		const n = d.perKind.get(kind) ?? 0;
		if (n >= MAX_EVIDENCE_PER_KIND_DAY) return;
		d.perKind.set(kind, n + 1);
		const e: WorkflowEvidence = { kind, session, line };
		if (relatedLine !== undefined) e.relatedLine = relatedLine;
		d.evidence.push(e);
	}

	role(day: string, role: string): WorkflowRoleDay {
		const k = `${day}\u0000${role}`;
		let r = this.roles.get(k);
		if (!r) this.roles.set(k, (r = { day, role, requests: 0, cost: 0, costKnown: 0, tokensKnown: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reasoningKnown: 0 }));
		return r;
	}
}

interface HandoffObs { day?: string; session: string; line: number; resolved: boolean }

function isError(r: WorkflowRecord): boolean {
	return r.kind === "assistant" && (r.providerError === true || r.stop === "error");
}

function promptFootprint(u: WorkflowUsage | undefined): number | undefined {
	const i = counter(u?.input), cr = counter(u?.cacheRead), cw = counter(u?.cacheWrite);
	return i === undefined || cr === undefined || cw === undefined ? undefined : i + cr + cw;
}

// ---------------------------------------------------------------- per-session lenses

/** Initial system records and the FIRST user record, before the first request, declare the role. */
function declaredRole(list: Rec[]): string {
	const found = new Set<string>();
	let userSeen = false;
	for (const { r } of list) {
		if (r.kind === "assistant" || r.kind === "tool-result") break;
		const isFirstUser = r.kind === "user" && !userSeen;
		if (r.kind === "user") userSeen = true;
		if ((r.kind === "system" || isFirstUser) && typeof r.role === "string") {
			const role = r.role.trim().slice(0, 64);
			if (role) found.add(role);
		}
	}
	return found.size === 1 ? [...found][0] : "unknown";
}

function errorsAndBursts(acc: Acc, list: Rec[]): void {
	let run: Rec[] = [];
	for (const e of list) {
		if (e.r.kind !== "assistant") continue;
		if (!isError(e.r)) { run = []; continue; }
		run.push(e);
		if (!e.dup) {
			acc.add(e.day, "providerErrors");
			acc.ensure(e.day, "providerBursts");
		}
		if (run.length === 3 && !e.dup) {
			const first = run.find((x) => x.day) ?? e;
			acc.add(first.day, "providerBursts");
			acc.evidence(first.day, "wakes-errors", first.session, run[0].r.line, e.r.line);
		}
	}
}

function duplicateDeliveries(acc: Acc, list: Rec[]): void {
	const used = new Set<number>();
	list.forEach((n, i) => {
		const candidates = [[str(n.r.deliveryHash), counter(n.r.deliveryBytes)], [str(n.r.deliveryAlternateHash), counter(n.r.deliveryAlternateBytes)]] as const;
		if (n.r.kind !== "notice" || !candidates.some(([h, b]) => h && b !== undefined && b > 0)) return;
		const end = Math.min(list.length, i + 1 + DELIVERY_WINDOW);
		for (let j = i + 1; j < end; j++) {
			const t = list[j];
			if (used.has(j) || t.r.kind !== "tool-result") continue;
			const matched = candidates.find(([h, b]) => h && b !== undefined && b > 0 && t.r.textHash === h && t.r.textBytes === b);
			if (matched) {
				const b = matched[1]!;
				used.add(j);
				if (!t.dup) {
					acc.add(t.day, "duplicateDeliveries");
					acc.add(t.day, "duplicateBytes", b);
					acc.evidence(t.day, "duplicate-delivery", t.session, t.r.line, n.r.line);
				}
				return;
			}
		}
	});
}

function verification(acc: Acc, list: Rec[]): void {
	const calls = new Map<string, { call: WorkflowCall; at: number; count: number }>();
	const results = new Map<string, number>();
	list.forEach((e, i) => {
		if (e.r.kind === "assistant") {
			for (const c of e.r.calls ?? []) {
				const id = isObj(c) ? str(c.id) : undefined;
				if (!id) continue;
				const prior = calls.get(id);
				if (prior) prior.count++;
				else calls.set(id, { call: c, at: i, count: 1 });
			}
		} else if (e.r.kind === "tool-result" && str(e.r.resultFor)) {
			results.set(e.r.resultFor!, (results.get(e.r.resultFor!) ?? 0) + 1);
		}
	});
	const family: WorkflowMetric[] = ["pairedTestCalls", "testExitKnown", "testExitZero", "testErrored", "testTimeouts", "testFiltered", "testForcedExit"];
	for (const e of list) {
		if (e.dup || e.r.kind !== "assistant") continue;
		for (const c of e.r.calls ?? []) {
			if (!isObj(c) || c.test !== true) continue;
			acc.add(e.day, "testCalls");
			acc.ensure(e.day, ...family);
			if (c.filtered === true) acc.add(e.day, "testFiltered");
			if (c.forcedExit === true) acc.add(e.day, "testForcedExit");
			acc.evidence(e.day, "verification", e.session, e.r.line);
		}
	}
	list.forEach((e, i) => {
		if (e.dup || e.r.kind !== "tool-result") return;
		const id = str(e.r.resultFor);
		const c = id ? calls.get(id) : undefined;
		if (!id || !c || c.count !== 1 || results.get(id) !== 1 || c.at >= i || c.call.test !== true) return;
		acc.ensure(e.day, "testCalls", ...family);
		acc.add(e.day, "pairedTestCalls");
		const code = e.r.exitCode;
		if (typeof code === "number" && Number.isInteger(code)) {
			acc.add(e.day, "testExitKnown");
			if (code === 0) acc.add(e.day, "testExitZero");
		}
		if (e.r.isError === true) acc.add(e.day, "testErrored");
		if (e.r.timeout === true) acc.add(e.day, "testTimeouts");
		acc.evidence(e.day, "verification", e.session, list[c.at].r.line, e.r.line);
	});
}

function chronology(acc: Acc, list: Rec[]): void {
	const family: WorkflowMetric[] = ["mutations", "nonTestNamedMutations", "firstTestAfterMutation", "baselineReads"];
	let mutatedAt: number | undefined;
	let firstTestSeen = false;
	for (const e of list) {
		if (e.r.kind !== "assistant") continue;
		for (const c of e.r.calls ?? []) {
			if (!isObj(c)) continue;
			if (c.test === true && !firstTestSeen) {
				firstTestSeen = true;
				if (!e.dup) {
					acc.ensure(e.day, ...family);
					if (mutatedAt !== undefined) {
						acc.add(e.day, "firstTestAfterMutation");
						acc.evidence(e.day, "chronology", e.session, e.r.line, mutatedAt);
					}
				}
			}
			if (e.dup) {
				if (c.mutation === true && mutatedAt === undefined) mutatedAt = e.r.line;
				continue;
			}
			if (c.mutation === true) {
				acc.ensure(e.day, ...family);
				acc.add(e.day, "mutations");
				if (c.testNamedPath === false) acc.add(e.day, "nonTestNamedMutations");
				if (mutatedAt === undefined) mutatedAt = e.r.line;
			}
			if (c.baselineRead === true) {
				acc.ensure(e.day, ...family);
				acc.add(e.day, "baselineReads");
				acc.evidence(e.day, "chronology", e.session, e.r.line);
			}
		}
	}
}

function startup(acc: Acc, list: Rec[]): void {
	const first = list.findIndex((e) => e.r.kind === "assistant");
	if (first < 0 || list[first].dup) return; // a copied startup is not another independent launch
	const unavailable = () => acc.add(list[first].day, "startupUnavailable");
	let sys = 0, hasSys = false, task: number | undefined, taskSeen = false, day: string | undefined, line = 0;
	for (let i = 0; i < first; i++) {
		const e = list[i];
		if (e.dup || (e.r.kind !== "system" && e.r.kind !== "user")) continue;
		const b = counter(e.r.textBytes);
		if (e.r.kind === "system") {
			// An empty stored system content string is not a measurement; measured sections are positive.
			if (b === undefined || b === 0) { unavailable(); return; }
			sys += b; hasSys = true;
		} else if (!taskSeen) {
			taskSeen = true;
			task = b;
		} else continue;
		if (!day && e.day) { day = e.day; line = e.r.line; }
	}
	if (!hasSys || task === undefined) { unavailable(); return; }
	acc.add(day, "startupConversations");
	acc.add(day, "startupSystemBytes", sys);
	acc.add(day, "startupTaskBytes", task);
	acc.evidence(day, "startup", list[0].session, line);
}

interface Pair { before: Rec; after: Rec }

function pairCompactions(list: Rec[]): Map<Rec, Pair> {
	const out = new Map<Rec, Pair>();
	const byId = new Map<string, Rec[]>();
	const children = new Map<string, Rec[]>();
	let linked = false;
	for (const e of list) {
		const id = str(e.r.id);
		if (id) { const l = byId.get(id); if (l) l.push(e); else byId.set(id, [e]); }
		const p = str(e.r.parentId);
		if (p) { linked = true; const l = children.get(p); if (l) l.push(e); else children.set(p, [e]); }
	}
	list.forEach((c, idx) => {
		if (c.dup || c.r.kind !== "compaction") return;
		const parent = str(c.r.parentId);
		if (parent) {
			const before = ancestorAssistant(parent, byId);
			const id = str(c.r.id);
			if (!before || !id || byId.get(id)?.length !== 1) return;
			const after = descendantAssistant(id, children);
			if (after) out.set(c, { before, after });
			return;
		}
		if (linked) return; // links exist elsewhere but not here: adjacency is unknown
		let b = -1, a = -1;
		for (let i = idx - 1; i >= 0; i--) {
			if (list[i].r.kind === "compaction" || list[i].r.kind === "context-edit") return;
			if (list[i].r.kind === "assistant") { b = i; break; }
		}
		for (let i = idx + 1; i < list.length; i++) {
			if (list[i].r.kind === "compaction" || list[i].r.kind === "context-edit") return;
			if (list[i].r.kind === "assistant") { a = i; break; }
		}
		if (b >= 0 && a >= 0) out.set(c, { before: list[b], after: list[a] });
	});
	return out;
}

function ancestorAssistant(start: string, byId: Map<string, Rec[]>): Rec | undefined {
	const seen = new Set<string>();
	let cur: string | undefined = start;
	while (cur && !seen.has(cur) && seen.size < MAX_TREE_NODES) {
		seen.add(cur);
		const cands = byId.get(cur);
		if (!cands || cands.length !== 1) return undefined;
		if (cands[0].r.kind === "assistant") return cands[0];
		if (cands[0].r.kind === "context-edit") return undefined;
		cur = str(cands[0].r.parentId);
	}
	return undefined;
}

/** The single assistant request reached below a compaction; branches or nested compactions are ambiguous. */
function descendantAssistant(rootId: string, children: Map<string, Rec[]>): Rec | undefined {
	const found = new Set<Rec>();
	const seen = new Set<string>([rootId]);
	const queue = [rootId];
	while (queue.length) {
		const id = queue.shift()!;
		for (const child of children.get(id) ?? []) {
			if (child.r.kind === "assistant") { found.add(child); continue; }
			if (child.r.kind === "compaction" || child.r.kind === "context-edit") return undefined;
			const cid = str(child.r.id);
			if (!cid || seen.has(cid) || seen.size >= MAX_TREE_NODES) continue;
			seen.add(cid);
			queue.push(cid);
		}
	}
	return found.size === 1 ? [...found][0] : undefined;
}

function compaction(acc: Acc, list: Rec[]): void {
	const pairs = pairCompactions(list);
	for (const c of list) {
		if (c.dup || c.r.kind !== "compaction") continue;
		acc.add(c.day, "compactions");
		acc.ensure(c.day, "compactionPairs", "beforePrompt", "afterPrompt");
		const p = pairs.get(c);
		if (!p) continue;
		const b = promptFootprint(p.before.r.usage), a = promptFootprint(p.after.r.usage);
		if (b === undefined || a === undefined) continue;
		acc.add(c.day, "compactionPairs");
		acc.add(c.day, "beforePrompt", b);
		acc.add(c.day, "afterPrompt", a);
		acc.evidence(c.day, "compaction", c.session, p.before.r.line, p.after.r.line);
	}
}

function telemetryAndRoles(acc: Acc, list: Rec[]): void {
	const role = declaredRole(list);
	for (const e of list) {
		if (e.dup) continue;
		if (e.r.kind === "opaque") { acc.add(e.day, "opaqueRecords"); acc.evidence(e.day, "telemetry", e.session, e.r.line); continue; }
		if (e.r.kind !== "assistant" || !e.day) continue;
		const u = isObj(e.r.usage) ? e.r.usage : undefined;
		const i = counter(u?.input), o = counter(u?.output), cr = counter(u?.cacheRead), cw = counter(u?.cacheWrite);
		const cost = counter(u?.cost), reasoning = counter(u?.reasoning);
		const tokens = i !== undefined && o !== undefined && cr !== undefined && cw !== undefined;
		acc.add(e.day, "assistantRecords");
		acc.ensure(e.day, "tokenComplete", "costComplete", "reasoningComplete");
		if (tokens) acc.add(e.day, "tokenComplete");
		if (cost !== undefined) acc.add(e.day, "costComplete");
		if (reasoning !== undefined) acc.add(e.day, "reasoningComplete");
		const row = acc.role(e.day, role);
		row.requests++;
		if (cost !== undefined) { row.cost += cost; row.costKnown++; }
		if (tokens) { row.tokensKnown++; row.input += i; row.output += o; row.cacheRead += cr; row.cacheWrite += cw; }
		if (reasoning !== undefined) { row.reasoning += reasoning; row.reasoningKnown++; }
	}
}

// ---------------------------------------------------------------- snapshot

export function buildWorkflowSnapshot(inputs: readonly WorkflowInput[]): WorkflowSnapshot {
	const acc = new Acc();
	const coverage: WorkflowSnapshot["coverage"] = { filesWithRecords: 0, filesWithoutRecords: 0, omittedRecords: 0 };
	const seenKeys = new Set<string>();
	const wakeSeen = new Set<string>();
	const abortByKey = new Map<string, HandoffObs>();
	const handoffs: HandoffObs[] = [];
	let opaque = 0;

	for (const input of Array.isArray(inputs) ? inputs : []) {
		const cap = isObj(input) ? input.capture : undefined;
		const session = isObj(input) && typeof input.sessionId === "string" ? input.sessionId : "";
		const raw: unknown = isObj(cap) && cap.version === 1 ? cap.records : undefined;
		const list: Rec[] = [];
		if (Array.isArray(raw)) {
			for (const item of raw) {
				if (!isObj(item) || typeof item.kind !== "string" || !KINDS.has(item.kind) || typeof item.line !== "number" || !Number.isFinite(item.line)) continue;
				const r = item as unknown as WorkflowRecord;
				const id = str(r.id) ?? "";
				// Copies (forks/resumes) keep id and content but may rewrite parent links and headers; records without ids never collide.
				const key = id === "" || /^line:\d+$/.test(id) ? "" : recordKey({ ...r, id });
				const dup = key !== "" && seenKeys.has(key);
				if (key !== "") seenKeys.add(key);
				list.push({ r: { ...r, id }, dup, day: localDay(r.at), session, key });
			}
		}
		if (isObj(cap) && cap.version === 1) {
			if (list.length > 0) coverage.filesWithRecords++; else coverage.filesWithoutRecords++;
			coverage.omittedRecords += counter(cap.omittedRecords) ?? 0;
		} else coverage.filesWithoutRecords++;
		if (list.length === 0) continue;
		for (const e of list) if (e.r.kind === "opaque" && !e.dup) opaque++;

		// Wakes: first occurrence is a group, later equal visible bodies are copies.
		for (const e of list) {
			if (e.dup || (e.r.kind !== "user" && e.r.kind !== "notice")) continue;
			const h = str(e.r.wakeHash);
			if (!h) continue;
			acc.ensure(e.day, "wakeGroups", "wakeCopies");
			if (wakeSeen.has(h)) { acc.add(e.day, "wakeCopies"); acc.evidence(e.day, "wakes-errors", session, e.r.line); }
			else { wakeSeen.add(h); acc.add(e.day, "wakeGroups"); }
		}
		errorsAndBursts(acc, list);
		duplicateDeliveries(acc, list);

		// Handoff: observation per conversation as of the last captured abort; a later actual final clears it.
		let current: HandoffObs | undefined;
		for (const e of list) {
			if (e.r.kind !== "assistant") continue;
			const key = e.key;
			if (e.r.stop === "aborted") {
				if (e.dup) {
					const shared = abortByKey.get(key);
					if (shared) current = shared;
				} else if (current && current.session === session) {
					Object.assign(current, { day: e.day, line: e.r.line, resolved: false });
					abortByKey.set(key, current);
				} else {
					current = { day: e.day, session, line: e.r.line, resolved: false };
					handoffs.push(current);
					abortByKey.set(key, current);
				}
			} else if (e.r.stop === "stop" && e.r.finalText === true && current) {
				current.resolved = true;
			}
		}

		verification(acc, list);
		chronology(acc, list);
		startup(acc, list);
		compaction(acc, list);
		telemetryAndRoles(acc, list);
	}

	for (const h of handoffs) {
		acc.add(h.day, "abortedConversations");
		acc.ensure(h.day, "abortedNoFinal");
		if (!h.resolved) {
			acc.add(h.day, "abortedNoFinal");
			acc.evidence(h.day, "missing-handoff", h.session, h.line);
		}
	}

	coverage.opaqueRecords = opaque;
	// Evidence budget: newest days first.
	let budget = MAX_EVIDENCE_TOTAL;
	for (const day of [...acc.days.keys()].sort().reverse()) {
		const d = acc.days.get(day)!;
		if (d.evidence.length > budget) d.evidence.length = budget;
		budget -= d.evidence.length;
	}
	const days: WorkflowDay[] = [...acc.days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, d]) => ({ day, metrics: d.metrics, evidence: d.evidence }));
	const roles = [...acc.roles.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
	return { version: 1, days, roles, coverage };
}

// ---------------------------------------------------------------- insights (fixed neutral prose)

type Totals = Partial<Record<WorkflowMetric, number>>;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const has = (t: Totals, ...ms: WorkflowMetric[]): boolean => ms.some((m) => t[m] !== undefined);

export function workflowInsights(snapshot: WorkflowSnapshot, startDay?: string, endDay?: string): WorkflowInsight[] {
	if (!isObj(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.days)) return [];
	const inRange = (day: unknown): boolean => typeof day === "string" && (startDay === undefined || day >= startDay) && (endDay === undefined || day <= endDay);
	const t: Totals = {};
	const evidence = new Map<WorkflowKind, WorkflowEvidence[]>();
	for (const d of [...snapshot.days].sort((a, b) => b.day.localeCompare(a.day))) {
		if (!isObj(d) || !inRange(d.day)) continue;
		for (const [k, v] of Object.entries(d.metrics ?? {})) {
			const n = counter(v);
			if (n !== undefined) t[k as WorkflowMetric] = (t[k as WorkflowMetric] ?? 0) + n;
		}
		for (const e of Array.isArray(d.evidence) ? d.evidence : []) evidence.set(e.kind, [...(evidence.get(e.kind) ?? []), e]);
	}
	const roles = new Map<string, WorkflowRoleDay>();
	for (const r of Array.isArray(snapshot.roles) ? snapshot.roles : []) {
		if (!isObj(r) || !inRange(r.day)) continue;
		const a = roles.get(r.role) ?? { day: "", role: r.role, requests: 0, cost: 0, costKnown: 0, tokensKnown: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reasoningKnown: 0 };
		for (const k of ["requests", "cost", "costKnown", "tokensKnown", "input", "output", "cacheRead", "cacheWrite", "reasoning", "reasoningKnown"] as const) a[k] += counter(r[k]) ?? 0;
		roles.set(r.role, a);
	}
	const g = (m: WorkflowMetric): number => t[m] ?? 0;
	const cov = snapshot.coverage;
	const cards = new Map<WorkflowKind, { headline: string; detail: string }>();

	if (has(t, "wakeGroups", "wakeCopies", "providerErrors", "providerBursts")) {
		const parts: string[] = [];
		if (has(t, "wakeGroups", "wakeCopies")) parts.push(`${plural(g("wakeGroups"), "distinct wake notification")} and ${plural(g("wakeCopies"), "later copy", "later copies")}.`);
		if (has(t, "providerErrors", "providerBursts")) parts.push(`${plural(g("providerErrors"), "provider-error record")}; ${plural(g("providerBursts"), "burst")} of three or more consecutive errors.`);
		parts.push("Error records with zero counters do not show that the surrounding work was free.");
		cards.set("wakes-errors", { headline: "Wake notifications and provider errors", detail: parts.join(" ") });
	}
	if (has(t, "duplicateDeliveries")) {
		cards.set("duplicate-delivery", {
			headline: `${plural(g("duplicateDeliveries"), "delivery body", "delivery bodies")} matched a later tool result`,
			detail: `Equal byte counts and exact hashes of captured report slices: ${g("duplicateBytes")} bytes in total. Equality does not show avoidability or that a read was needed or not; file-only notices, different versions and partial previews are not matched.`,
		});
	}
	if (has(t, "abortedConversations", "abortedNoFinal")) {
		cards.set("missing-handoff", {
			headline: `${plural(g("abortedConversations"), "captured conversation")} with an abort; ${g("abortedNoFinal")} without a later final report`,
			detail: "Observed as of this snapshot and dated by the abort. A final report in the captured records clears the observation. This does not show whether external artifacts exist, and one conversation is not necessarily one independent run.",
		});
	}
	if (has(t, "testCalls", "pairedTestCalls")) {
		cards.set("verification", {
			headline: `${plural(g("testCalls"), "test or check call")}; ${g("pairedTestCalls")} paired with a result`,
			detail: `Of the paired results, ${g("testExitKnown")} have a numeric exit code (${g("testExitZero")} zero), ${g("testErrored")} carry an error flag and ${g("testTimeouts")} carry a recorded timeout flag or marker (absence of the marker does not show that none occurred). Filtered pipelines: ${g("testFiltered")}; forced-exit flags: ${g("testForcedExit")}. A non-error receipt or printed pass count does not establish compiler success; nonzero results can be expected baseline or recovered work.`,
		});
	}
	if (has(t, "mutations", "firstTestAfterMutation", "baselineReads")) {
		cards.set("chronology", {
			headline: `${plural(g("mutations"), "declared edit or write")} in captured order`,
			detail: `${g("nonTestNamedMutations")} target paths that are not test-named (a naming fact, not production semantics). ${plural(g("firstTestAfterMutation"), "conversation")} ran a first test or check after an earlier edit; this is ordering only. ${plural(g("baselineReads"), "literal git show REV:PATH baseline-read command")} observed, which is not RED or GREEN proof; ordinary file reads are not counted.`,
		});
	}
	if (has(t, "startupConversations", "startupUnavailable")) {
		cards.set("startup", {
			headline: `${plural(g("startupConversations"), "conversation")} with measured startup text`,
			detail: `Initial stored system text ${g("startupSystemBytes")} bytes and first task text ${g("startupTaskBytes")} bytes (UTF-8, excluding tool declarations). These bytes are not provider tokens, replay costs or dispensable instructions. ${g("startupUnavailable")} conversations have unavailable startup measurements.`,
		});
	}
	if (roles.size > 0) {
		const rows = [...roles.values()].sort((a, b) => b.requests - a.requests || (a.role < b.role ? -1 : 1));
		const line = (r: WorkflowRoleDay) => `${r.role}: ${plural(r.requests, "request")}, recorded valuation ${Math.round(r.cost * 1e6) / 1e6} from ${r.costKnown} of ${r.requests}, counters complete for ${r.tokensKnown}`;
		const shown = rows.slice(0, 5).map(line);
		if (rows.length > 5) shown.push(`${rows.length - 5} more roles`);
		cards.set("roles", {
			headline: `${plural(rows.length, "declared role")} (including unknown)`,
			detail: `${shown.join("; ")}. Roles come from an explicit declaration in the initial preamble only; otherwise unknown. Valuation is the sum of recorded values, not an invoice.`,
		});
	}
	if (has(t, "compactions", "compactionPairs")) {
		cards.set("compaction", {
			headline: `${plural(g("compactions"), "captured compaction")}; ${g("compactionPairs")} with complete before/after counters`,
			detail: `Matched pairs only: normalized prompt ${g("beforePrompt")} before and ${g("afterPrompt")} after. Ambiguous or unlinked adjacency is not presented as verified. No latency, cache-expiry or summary-quality claim is made.`,
		});
	}
	const covIncomplete = isObj(cov) && ((cov.omittedRecords ?? 0) > 0 || (cov.opaqueRecords ?? 0) > 0 || cov.filesWithoutRecords > 0);
	if (has(t, "assistantRecords", "opaqueRecords") || covIncomplete) {
		const parts: string[] = [];
		if (has(t, "assistantRecords")) parts.push(`${plural(g("assistantRecords"), "assistant record")}: counters complete for ${g("tokenComplete")}, cost recorded for ${g("costComplete")}, reasoning recorded for ${g("reasoningComplete")}. Missing or malformed fields are unknown, not zero.`);
		else parts.push("No captured assistant records are dated in the selected period.");
		if (has(t, "opaqueRecords")) parts.push(`${plural(g("opaqueRecords"), "dated record")} in this period could not be normalized.`);
		if (isObj(cov)) {
			const opaque = cov.opaqueRecords === undefined ? "" : `, ${plural(cov.opaqueRecords, "opaque record")}`;
			parts.push(`Scan coverage (whole snapshot, not this period): ${plural(cov.filesWithRecords, "file")} with captured records, ${cov.filesWithoutRecords} without, ${plural(cov.omittedRecords, "record")} omitted${opaque}${covIncomplete ? "; coverage is incomplete" : ""}.`);
		}
		cards.set("telemetry", { headline: plural(g("assistantRecords"), "captured assistant record"), detail: parts.join(" ") });
	}

	return LENS_ORDER.filter((k) => cards.has(k)).map((kind) => ({ kind, ...cards.get(kind)!, evidence: evidence.get(kind) ?? [] }));
}
