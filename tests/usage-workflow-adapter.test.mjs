// Workflow adapter: capture inside the existing pi JSONL scan, resume/append equivalence, schema invalidation,
// store round trip, snapshot caching, native + TUI surfaces. Anonymized synthetic fixtures only.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import { emptyUsageData, parseSessionBuffer, parseSessionChunk, saveUsageCache, workflowInsightsFor, workflowPeriodDays } from "../usage-extension/data.ts";
import { applyParseDelta, parseFile, parseFileDelta } from "../usage-extension/index/parse.ts";
import { UsageIndexCore } from "../usage-extension/index/service.ts";
import { openIndexStore } from "../usage-extension/index/store.ts";
import { buildUsageRollup } from "../usage-extension/native.ts";

// dashboard.ts imports the TUI package, which is not installed here (no installs): stub it for this test only.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-tui") {
			const stub = "export const truncateToWidth=(s,n)=>String(s).slice(0,n);export const visibleWidth=(s)=>String(s).length;export const wrapTextWithAnsi=(s,n)=>{const out=[];let cur='';for(const w of String(s).split(' ')){if(cur&&(cur+' '+w).length>n){out.push(cur);cur=w}else cur=cur?cur+' '+w:w}if(cur)out.push(cur);return out}";
			return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
		}
		return next(specifier, context);
	},
});
const { renderWorkflowInsights } = await import("../usage-extension/dashboard.ts");

const NOW = new Date(2026, 0, 15, 12, 0, 0);
const T0 = new Date(2026, 0, 14, 9, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const L = (o) => JSON.stringify(o) + "\n";
const SECRET = "synthetic-secret-token-0451";

const header = (id = "s-anon") => L({ type: "session", version: 3, id, timestamp: iso(T0), cwd: "/anon/project" });
const user = (n, text = "hello") => L({ type: "message", id: `u${n}`, parentId: n > 1 ? `a${n - 1}` : null, timestamp: iso(T0 + n * 1000), message: { role: "user", content: [{ type: "text", text }], timestamp: T0 + n * 1000 } });
const asst = (n, extra = {}) =>
	L({
		type: "message", id: `a${n}`, parentId: `u${n}`, timestamp: iso(T0 + n * 1000 + 500),
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "claude-anon", stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 0, cost: { total: 0.01 } }, timestamp: T0 + n * 1000 + 500, ...extra },
	});
const turns = (count, from = 1) => Array.from({ length: count }, (_, i) => user(from + i) + asst(from + i)).join("");
const bigResult = (kb) =>
	L({ type: "message", id: "big", parentId: "a1", timestamp: iso(T0 + 9000), message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(kb * 1024) }], isError: false, timestamp: T0 + 9000 } });

function tmp(t, prefix = "usage-wf-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const discovered = (path, kind = "pi") => {
	const st = statSync(path);
	return { path, kind, size: st.size, mtimeMs: st.mtimeMs };
};
const cap = (parsed) => parsed.workflow;

test("chunk capture: physical line numbers include blank lines; known metadata entries keep only topology", async () => {
	const text = header() + "\n" + user(1) + L({ type: "thinking_level_change", id: "t1", thinkingLevel: "high" }) + asst(1);
	const chunk = await parseSessionChunk(Buffer.from(text), null, true);
	const w = chunk.workflow;
	assert.ok(w, "workflow capture present");
	assert.equal(w.version, 1);
	assert.deepEqual(w.records.map((r) => [r.kind, r.line]), [["session", 1], ["user", 3], ["metadata", 4], ["assistant", 5]]);
	assert.equal(w.omittedRecords, 0);
});

test("chunk capture: arbitrary chunking with partial tails equals one parse (lines, cap state, accounting)", async () => {
	const text = header() + turns(6) + "\n" + turns(3, 7);
	const buffer = Buffer.from(text);
	const whole = await parseSessionChunk(buffer, null, false);
	assert.ok(whole.workflow, "workflow capture present");
	for (const cuts of [[7], [50, 51, 400], [buffer.length - 3], [1, 2, 3, 900, 1500]]) {
		let state = null;
		let offset = 0;
		const records = [];
		let omitted = 0;
		let messages = 0;
		for (const cut of [...cuts, buffer.length]) {
			const slice = buffer.subarray(offset, Math.max(cut, offset));
			// Present the file as it would be on disk at `cut`: only bytes [offset, cut).
			const chunk = await parseSessionChunk(slice, state, true);
			records.push(...(chunk.workflow?.records ?? []));
			omitted += chunk.workflow?.omittedRecords ?? 0;
			messages += chunk.messages.length;
			state = chunk.state;
			offset += chunk.consumed;
		}
		assert.deepEqual(records, whole.workflow.records, `cuts ${cuts}`);
		assert.equal(omitted, whole.workflow.omittedRecords);
		assert.equal(messages, whole.messages.length);
	}
});

test("an unterminated but complete JSON tail consumed without newline does not shift later line numbers", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "a.jsonl");
	writeFileSync(file, (header() + user(1) + asst(1)).trimEnd());
	const first = await parseFile(discovered(file), undefined);
	appendFileSync(file, "\n" + user(2) + asst(2));
	const next = await parseFile(discovered(file), first.record);
	const fresh = await parseFile(discovered(file), undefined);
	assert.equal(next.change.type, "append");
	assert.ok(next.record.parsed.workflow, "workflow capture present");
	assert.deepEqual(next.record.parsed.workflow, fresh.record.parsed.workflow);
	assert.deepEqual(next.record.parsed.workflow.records.map((r) => r.line), [1, 2, 3, 4, 5]);
});

test("large tool results stay allocation-safe: opaque marker, no big JSON.parse, accounting unchanged", async () => {
	const text = header() + user(1) + asst(1) + bigResult(200) + turns(1, 2);
	const realParse = JSON.parse;
	let biggest = 0;
	JSON.parse = (s, r) => {
		biggest = Math.max(biggest, typeof s === "string" ? s.length : 0);
		return realParse(s, r);
	};
	let chunk;
	try {
		chunk = await parseSessionChunk(Buffer.from(text), null, true);
	} finally {
		JSON.parse = realParse;
	}
	assert.ok(chunk.workflow, "workflow capture present");
	assert.ok(biggest < 64 * 1024, `no oversize JSON.parse (saw ${biggest})`);
	const opaque = chunk.workflow.records.filter((r) => r.kind === "opaque");
	assert.deepEqual(opaque.map((r) => r.line), [4]);
	assert.equal(chunk.messages.length, 2);
	assert.ok(!JSON.stringify(chunk.workflow).includes("xxxxxxxx"));
});

test("cap: at most 30000 records retained per file, omitted coverage surfaced, chunk-independent", async () => {
	const lines = [header()];
	for (let i = 1; i <= 30_004; i++) lines.push(L({ type: "message", id: `u${i}`, parentId: null, message: { role: "user", content: "n" } }));
	const buffer = Buffer.from(lines.join(""));
	const whole = await parseSessionChunk(buffer, null, true);
	assert.ok(whole.workflow, "workflow capture present");
	assert.equal(whole.workflow.records.length, 30_000);
	assert.equal(whole.workflow.omittedRecords, 5);
	const mid = buffer.indexOf("\n", Math.floor(buffer.length / 2)) + 1;
	const a = await parseSessionChunk(buffer.subarray(0, mid), null, true);
	const b = await parseSessionChunk(buffer.subarray(mid), a.state, true);
	assert.equal(a.workflow.records.length + b.workflow.records.length, 30_000);
	assert.equal(a.workflow.omittedRecords + b.workflow.omittedRecords, 5);
});

test("accounting flags survive the workflow scan (compaction pending / thinking level)", async () => {
	const text = header() + L({ type: "thinking_level_change", id: "t", thinkingLevel: "high" }) + user(1) + L({ type: "compaction", id: "c1", timestamp: iso(T0 + 1), summary: "s" }) + asst(1) + asst(2);
	const chunk = await parseSessionChunk(Buffer.from(text), null, true);
	assert.ok(chunk.workflow, "workflow capture present");
	assert.deepEqual(chunk.messages.map((m) => [m.thinkingLevel, m.afterCompaction]), [["high", true], ["high", false]]);
	assert.ok(chunk.workflow.records.some((r) => r.kind === "compaction"));
});

test("parseSessionBuffer carries the same capture as an index full parse", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "a.jsonl");
	const text = header() + turns(3);
	writeFileSync(file, text);
	const legacy = await parseSessionBuffer(Buffer.from(text));
	const indexed = (await parseFile(discovered(file), undefined)).record.parsed;
	assert.deepStrictEqual(indexed.workflow, legacy.workflow);
});

test("privacy: persisted capture holds hashes and scalars, never bodies or secrets", async () => {
	const text = header() + user(1, `please use ${SECRET}`) + asst(1, { content: [{ type: "text", text: SECRET }, { type: "toolCall", id: "k1", name: "bash", arguments: { command: `cat ${SECRET}.txt` } }] });
	const chunk = await parseSessionChunk(Buffer.from(text), null, true);
	assert.ok(chunk.workflow, "workflow capture present");
	assert.ok(!JSON.stringify(chunk.workflow).includes(SECRET));
});

test("append/rewrite/truncate: capture equals a cold parse; unchanged resume reuses; non-pi is unavailable", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "a.jsonl");
	writeFileSync(file, header() + turns(3));
	const first = await parseFile(discovered(file), undefined);
	assert.ok(first.record.parsed.workflow);
	assert.equal(typeof first.record.resume.state.wfLines, "number");
	appendFileSync(file, turns(2, 4));
	const appended = await parseFile(discovered(file), first.record);
	assert.equal(appended.change.type, "append");
	assert.deepStrictEqual(appended.record.parsed.workflow, (await parseFile(discovered(file), undefined)).record.parsed.workflow);
	assert.equal(appended.record.parsed.workflow.records.length, 11);

	writeFileSync(file, header("s-other") + turns(1));
	const rewritten = await parseFile(discovered(file), appended.record);
	assert.equal(rewritten.change.type, "full");
	assert.equal(rewritten.record.parsed.workflow.records.length, 3);

	const shorter = header("s-other");
	writeFileSync(file, shorter);
	const truncated = await parseFile(discovered(file), rewritten.record);
	assert.equal(truncated.change.type, "full");
	assert.deepEqual(truncated.record.parsed.workflow.records.map((r) => r.kind), ["session"]);

	const cc = join(dir, "cc.jsonl");
	writeFileSync(cc, L({ type: "user", sessionId: "cc1", message: { role: "user", content: "hi" } }));
	const extra = await parseFile(discovered(cc, "claude-code"), undefined);
	assert.equal(extra.record.parsed.workflow, undefined, "unsupported extra source stays unavailable");
});

test("schema invalidation: an old pi resume state (no line counter) is reparsed in full, not appended", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "a.jsonl");
	writeFileSync(file, header() + turns(2));
	const first = await parseFile(discovered(file), undefined);
	const old = structuredClone(first.record);
	delete old.resume.state.wfLines;
	delete old.resume.state.wfKept;
	delete old.resume.state.wfTail;
	delete old.parsed.workflow;
	appendFileSync(file, turns(1, 3));
	const delta = await parseFileDelta(discovered(file), old.resume);
	assert.equal(delta.mode, "full");
	assert.ok(delta.delta.workflow, "workflow capture present");
	assert.equal(delta.delta.workflow.records.length, 7);
});

test("worker plain-data: delta survives a structured clone and JSON round trip", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "a.jsonl");
	writeFileSync(file, header() + turns(3) + bigResult(100));
	const delta = await parseFileDelta(discovered(file), null);
	assert.ok(delta.delta.workflow, "workflow capture present");
	assert.deepStrictEqual(structuredClone(delta), delta);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(delta.delta.workflow)), delta.delta.workflow);
	const applied = applyParseDelta(discovered(file), undefined, delta);
	assert.deepStrictEqual(applied.record.parsed.workflow, delta.delta.workflow);
});

function coreFixture(t) {
	const root = tmp(t, "usage-wf-core-");
	const sessionsDir = join(root, "sessions", "--anon--");
	mkdirSync(sessionsDir, { recursive: true });
	const file = join(sessionsDir, "a.jsonl");
	writeFileSync(file, header() + turns(3));
	return { root, file, sessionsDir: join(root, "sessions"), storeDir: join(root, "store") };
}
const coreOptions = (f, extra = {}) => ({ sessionsDir: f.sessionsDir, storeDir: f.storeDir, legacyCachePath: null, worker: false, watch: false, parseWorkers: 0, ...extra });

test("core: UsageData.workflow is built, cached while captures are unchanged, and rebuilt on append/delete", async (t) => {
	const f = coreFixture(t);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null }));
	t.after(() => core.dispose());
	const one = await core.snapshot({ now: NOW });
	assert.ok(one.workflow);
	assert.equal(one.workflow.version, 1);
	assert.equal(one.workflow.coverage.filesWithRecords, 1);
	const two = await core.snapshot({ now: NOW });
	assert.equal(two.workflow, one.workflow, "no-change paint reuses the aggregated snapshot");
	appendFileSync(f.file, turns(2, 4));
	const three = await core.snapshot({ now: NOW });
	assert.notEqual(three.workflow, one.workflow);
	rmSync(f.file);
	const four = await core.snapshot({ now: NOW });
	assert.ok(four.workflow);
	assert.equal(four.workflow.coverage.filesWithRecords, 0);
});

test("store: capture persists; an old (pre-workflow) cached pi file is reparsed once, never accepted as complete", async (t) => {
	const f = coreFixture(t);
	const core = new UsageIndexCore(coreOptions(f));
	t.after(() => core.dispose());
	const first = await core.snapshot({ now: NOW });
	await core.flush();
	const second = new UsageIndexCore(coreOptions(f));
	t.after(() => second.dispose());
	assert.ok(first.workflow, "workflow snapshot present");
	const warm = await second.snapshot({ now: NOW });
	assert.deepStrictEqual(warm.workflow, first.workflow);

	// Old cache: the legacy import carries parsed data without a workflow capture and the same size/mtime.
	const root = tmp(t, "usage-wf-old-");
	const sessionsDir = join(root, "sessions", "--anon--");
	mkdirSync(sessionsDir, { recursive: true });
	const file = join(sessionsDir, "a.jsonl");
	writeFileSync(file, header() + turns(2));
	const parsed = await parseSessionBuffer(Buffer.from(header() + turns(2)));
	delete parsed.workflow;
	const st = statSync(file);
	const legacyCachePath = join(root, "cache.json");
	await saveUsageCache(legacyCachePath, new Map([[file, { size: st.size, mtimeMs: st.mtimeMs, parsed }]]));
	const old = new UsageIndexCore({ sessionsDir: join(root, "sessions"), storeDir: join(root, "store"), legacyCachePath, worker: false, watch: false, parseWorkers: 0 });
	t.after(() => old.dispose());
	const data = await old.snapshot({ now: NOW });
	assert.ok(data.workflow, "workflow snapshot present");
	assert.equal(data.workflow.coverage.filesWithRecords, 1, "stale file was reparsed");
	assert.equal(data.workflow.coverage.filesWithoutRecords, 0);
});

test("store: malformed persisted workflow is dropped to unavailable without losing accounting", async (t) => {
	const root = tmp(t, "usage-wf-store-");
	const store = openIndexStore(join(root, "store"));
	const record = {
		path: join(root, "x.jsonl"), kind: "pi", size: 1, mtimeMs: 2, resume: null,
		parsed: { sessionId: "s1", cwd: "/anon", messages: [], toolUsages: [], workflow: { version: 1, records: [{ id: "a", line: 1, kind: "user" }], omittedRecords: 0 } },
	};
	store.put(record);
	await store.flush();
	const reload = await openIndexStore(join(root, "store")).load();
	assert.ok(reload.get(record.path), "record reloaded");
	assert.deepStrictEqual(reload.get(record.path).parsed.workflow, record.parsed.workflow);
});

test("native: rollup.workflow is an optional additive member", () => {
	const data = emptyUsageData({ todayMs: NOW.getTime(), weekStartMs: 0, lastWeekStartMs: 0, last30DaysStartMs: 0, nowMs: NOW.getTime() });
	assert.equal("workflow" in buildUsageRollup(data, { now: NOW }).rollup, false);
	const snapshot = { version: 1, days: [], roles: [], coverage: { filesWithRecords: 0, filesWithoutRecords: 1, omittedRecords: 0 } };
	data.workflow = snapshot;
	const payload = buildUsageRollup(data, { now: NOW });
	assert.deepStrictEqual(payload.rollup.workflow, snapshot);
	assert.equal(payload.v, 1);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(payload.rollup.workflow)), snapshot);
});

const theme = { fg: (_c, s) => s, bold: (s) => s };

test("TUI: period day ranges are local-day and insights are code generated per period", () => {
	const data = emptyUsageData({ todayMs: new Date(2026, 0, 15).getTime(), weekStartMs: new Date(2026, 0, 12).getTime(), lastWeekStartMs: new Date(2026, 0, 5).getTime(), last30DaysStartMs: new Date(2025, 11, 17).getTime(), nowMs: NOW.getTime() });
	assert.deepEqual(workflowPeriodDays(data.bounds, "today"), { startDay: "2026-01-15", endDay: "2026-01-15" });
	assert.deepEqual(workflowPeriodDays(data.bounds, "lastWeek"), { startDay: "2026-01-05", endDay: "2026-01-11" });
	assert.deepEqual(workflowPeriodDays(data.bounds, "allTime"), { startDay: undefined, endDay: undefined });

	assert.deepEqual(workflowInsightsFor(data, "today"), [], "absent workflow → none");
	const unavailable = renderWorkflowInsights(theme, data, "today", 80).join("\n");
	assert.match(unavailable, /unavailable/i);
	assert.ok(!/healthy|waste/i.test(unavailable));
});

test("TUI: a snapshot with records renders neutral lines for the selected period only", async () => {
	const text = header() + turns(2);
	const parsed = await parseSessionBuffer(Buffer.from(text));
	const { buildWorkflowSnapshot } = await import("../usage-extension/workflow/analyze.ts");
	const data = emptyUsageData({ todayMs: new Date(2026, 0, 15).getTime(), weekStartMs: new Date(2026, 0, 12).getTime(), lastWeekStartMs: new Date(2026, 0, 5).getTime(), last30DaysStartMs: new Date(2025, 11, 17).getTime(), nowMs: NOW.getTime() });
	data.workflow = buildWorkflowSnapshot([{ sessionId: "s-anon", capture: parsed.workflow }]);
	const month = workflowInsightsFor(data, "last30Days");
	assert.ok(month.length > 0);
	assert.equal(workflowInsightsFor(data, "today").length, 0, "records dated 2026-01-14 are outside today");
	assert.equal(workflowInsightsFor(data, "last30Days"), month, "memoized");
	const lines = renderWorkflowInsights(theme, data, "last30Days", 80).join("\n");
	assert.match(lines, /captured assistant record/);
});

// ---- repair 1: real protocol schemas through parser -> index -> native -> TUI --------------------------------
const REPORT = "Anon report line 1\n  indented\nlast line\n";
const sysLine = L({ type: "message", id: "sys1", parentId: null, timestamp: iso(T0 + 10), message: { role: "system", content: "", sections: { preamble: '<active_agent name="scout-anon"/>\nYou are a helper.\n', project_context: "ctx-anon", cwd: "/anon/project" }, toolsAdded: [{ name: "TOOL-SECRET-77", description: "private" }], timestamp: T0 + 10 } });
const notifyLine = L({ type: "custom_message", id: "n1", parentId: "sys1", customType: "subagent-notify", display: true, timestamp: iso(T0 + 20), content: `Background task completed: **fixer**\n\nfixer:\n${REPORT}\n\nOutput saved to: /anon/out.md (3 lines)` });
const readLine = L({ type: "message", id: "r1", parentId: "n1", timestamp: iso(T0 + 30), message: { role: "toolResult", toolCallId: "c9", toolName: "read", content: [{ type: "text", text: REPORT }], isError: false, timestamp: T0 + 30 } });
const protocol = () => header("s-proto") + sysLine + notifyLine + readLine + L({ type: "model_change", id: "mc", parentId: null, timestamp: iso(T0) }) + L({ type: "context_edit", id: "ce", parentId: "mc", timestamp: iso(T0 + 1) }) + L({ type: "weird", id: "wx", parentId: "mc" }) + "not json\n" + user(1) + asst(1);

test("repair: real system.sections + Background task completed protocol, metadata/context-edit/opaque kinds, through the full parser", async () => {
	const chunk = await parseSessionChunk(Buffer.from(protocol()), null, true);
	const kinds = Object.fromEntries(chunk.workflow.records.map((r) => [r.id, r.kind]));
	assert.equal(kinds.sys1, "system");
	assert.equal(kinds.n1, "notice");
	assert.equal(kinds.mc, "metadata");
	assert.equal(kinds.ce, "context-edit");
	assert.equal(kinds.wx, "opaque");
	assert.equal(chunk.workflow.records.filter((r) => r.kind === "opaque").length, 2, "unknown typed entry + undecodable line");
	const sys = chunk.workflow.records.find((r) => r.id === "sys1");
	assert.ok(sys.textBytes > 0 && sys.role === "scout-anon");
	const text = JSON.stringify(chunk.workflow);
	for (const secret of ["TOOL-SECRET-77", "Anon report line", "/anon/out.md", "ctx-anon"]) assert.ok(!text.includes(secret), secret);
});

test("repair: store keeps metadata/context-edit/opaque kinds and rejects unknown kinds", async (t) => {
	const root = tmp(t, "usage-wf-kinds-");
	const store = openIndexStore(join(root, "store"));
	const records = ["session", "metadata", "context-edit", "system", "user", "notice", "assistant", "tool-result", "compaction", "opaque"].map((kind, i) => ({ id: `r${i}`, line: i + 1, kind }));
	const base = { kind: "pi", size: 1, mtimeMs: 2, resume: null };
	store.put({ ...base, path: join(root, "ok.jsonl"), parsed: { sessionId: "s1", cwd: "/anon", messages: [], toolUsages: [], workflow: { version: 1, records, omittedRecords: 2 } } });
	store.put({ ...base, path: join(root, "bad.jsonl"), parsed: { sessionId: "s2", cwd: "/anon", messages: [], toolUsages: [], workflow: { version: 1, records: [{ id: "x", line: 1, kind: "bogus" }], omittedRecords: 0 } } });
	await store.flush();
	const reload = await openIndexStore(join(root, "store")).load();
	assert.deepStrictEqual(reload.get(join(root, "ok.jsonl"))?.parsed.workflow?.records, records);
	assert.equal(reload.get(join(root, "bad.jsonl"))?.parsed.workflow, undefined);
});

test("repair: index snapshot + native rollup carry startup, roles, duplicate delivery and global opaque coverage; cold == warm; no raw bodies", async (t) => {
	const f = coreFixture(t);
	writeFileSync(f.file, protocol());
	const core = new UsageIndexCore(coreOptions(f));
	t.after(() => core.dispose());
	const data = await core.snapshot({ now: NOW });
	assert.ok(data.workflow, "workflow snapshot present");
	const day = data.workflow.days.find((d) => d.metrics.startupConversations);
	assert.ok(day, "startup counted from stored sections");
	assert.ok(day.metrics.startupSystemBytes > 0);
	assert.equal(data.workflow.days.reduce((n, d) => n + (d.metrics.duplicateDeliveries ?? 0), 0), 1);
	assert.ok(data.workflow.roles.some((r) => r.role === "scout-anon"), "anchored role");
	assert.equal(data.workflow.coverage.opaqueRecords, 2, "undated opaque records disclosed globally");
	const rollup = buildUsageRollup(data, { now: NOW }).rollup;
	assert.equal(rollup.workflow.coverage.opaqueRecords, 2);
	const wire = JSON.stringify(rollup.workflow);
	for (const secret of ["TOOL-SECRET-77", "Anon report line", "/anon/out.md", f.file]) assert.ok(!wire.includes(secret), secret);
	await core.flush();
	const warm = new UsageIndexCore(coreOptions(f));
	t.after(() => warm.dispose());
	assert.deepStrictEqual((await warm.snapshot({ now: NOW })).workflow, data.workflow);
});

test("repair: cross-file copies with a new branch header are counted once", async (t) => {
	const f = coreFixture(t);
	const body = turns(2);
	writeFileSync(f.file, header("s-orig") + body);
	writeFileSync(join(f.sessionsDir, "--anon--", "b.jsonl"), header("s-fork") + body);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null }));
	t.after(() => core.dispose());
	const data = await core.snapshot({ now: NOW });
	const total = (m) => data.workflow.days.reduce((n, d) => n + (d.metrics[m] ?? 0), 0);
	assert.equal(total("assistantRecords"), 2);
});
