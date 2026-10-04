import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowSnapshot, workflowInsights } from "../usage-extension/workflow/analyze.ts";

// ---- anonymized synthetic fixtures -------------------------------------------------
const T1 = new Date(2026, 0, 5, 12, 0, 0).getTime();
const T2 = new Date(2026, 0, 6, 12, 0, 0).getTime();
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const D1 = dayOf(T1);
const D2 = dayOf(T2);

const rec = (id, line, kind, extra = {}) => ({ id, line, kind, at: T1 + line, ...extra });
const input = (sessionId, records, omittedRecords = 0) => ({ sessionId, capture: { version: 1, records, omittedRecords } });
const snap = (...inputs) => buildWorkflowSnapshot(inputs);
const dayRow = (s, day) => s.days.find((d) => d.day === day);
const metric = (s, day, name) => dayRow(s, day)?.metrics[name];
const full = (extra = {}) => ({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, ...extra });
const asst = (id, line, extra = {}) => rec(id, line, "assistant", { stop: "stop", usage: full(), ...extra });
const call = (id, extra = {}) => ({ id, name: "bash", ...extra });

test("empty and untrusted inputs produce a versioned empty snapshot with honest coverage", () => {
	const s = buildWorkflowSnapshot([
		{ sessionId: "a" },
		{ sessionId: "b", capture: { version: 2, records: [rec("x", 1, "assistant")], omittedRecords: 4 } },
		{ sessionId: "c", capture: { version: 1, records: [], omittedRecords: 2 } },
		{ sessionId: "d", capture: { version: 1, records: [null, 7, "x", rec("ok", 1, "assistant", { usage: full() })], omittedRecords: 1 } },
	]);
	assert.equal(s.version, 1);
	assert.equal(s.coverage.filesWithRecords, 1);
	assert.equal(s.coverage.filesWithoutRecords, 3);
	assert.equal(s.coverage.omittedRecords, 3);
	assert.equal(metric(s, D1, "assistantRecords"), 1);
	assert.deepEqual(workflowInsights(buildWorkflowSnapshot([])), []);
});

test("wakes: copies after first occurrence are separate from groups; non-wake text is ignored", () => {
	const s = snap(
		input("s1", [rec("a", 1, "user", { wakeHash: "w1" }), rec("b", 2, "notice", { wakeHash: "w1" }), rec("c", 3, "user", { wakeHash: "w2" }), rec("d", 4, "user", { textHash: "w1" })]),
		input("s2", [rec("e", 1, "notice", { wakeHash: "w1", at: T2 })]),
	);
	assert.equal(metric(s, D1, "wakeGroups"), 2);
	assert.equal(metric(s, D1, "wakeCopies"), 1);
	assert.equal(metric(s, D2, "wakeCopies"), 1);
	assert.equal(metric(s, D2, "wakeGroups") ?? 0, 0);
});

test("provider errors and bursts: three consecutive errors form a burst; a nonerror assistant breaks it; zero counters still count", () => {
	const err = (id, line, extra = {}) => asst(id, line, { stop: "error", providerError: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, ...extra });
	const s = snap(
		input("s1", [err("a", 1), err("b", 2), rec("t", 3, "tool-result"), err("c", 4), asst("ok", 5), err("d", 6), err("e", 7)]),
		input("s2", [err("f", 1), err("g", 2), err("h", 3), err("i", 4)]),
	);
	assert.equal(metric(s, D1, "providerErrors"), 9);
	assert.equal(metric(s, D1, "providerBursts"), 2);
	assert.equal(metric(s, D1, "assistantRecords"), 10);
	assert.equal(metric(s, D1, "tokenComplete"), 10);
	const cards = workflowInsights(s, D1, D1);
	const card = cards.find((c) => c.kind === "wakes-errors");
	assert.ok(card);
	assert.match(card.detail, /zero counters/);
	// error-only records are not an abandoned handoff
	assert.equal(metric(s, D1, "abortedNoFinal"), undefined);
});

test("duplicate delivery requires equal bytes AND hash; controls do not match; cross-day attributes to the result day", () => {
	const notice = (id, line, h, b, extra = {}) => rec(`${id}-n`, line, "notice", { deliveryHash: h, deliveryBytes: b, ...extra });
	const result = (id, line, h, b, extra = {}) => rec(`${id}-r`, line, "tool-result", { textHash: h, textBytes: b, ...extra });
	const s = snap(
		input("eq", [notice("eq", 1, "h", 100), result("eq", 2, "h", 100, { at: T2 })]),
		input("hash", [notice("hash", 1, "h", 100), result("hash", 2, "other", 100)]),
		input("bytes", [notice("bytes", 1, "h", 100), result("bytes", 2, "h", 99)]),
		input("before", [result("before", 1, "h", 100), notice("before", 2, "h", 100)]),
		input("missing", [notice("missing", 1, "h", undefined), result("missing", 2, "h", undefined)]),
		input("zero", [notice("zero", 1, "h", 0), result("zero", 2, "h", 0)]),
		input("far", [notice("far", 1, "h", 100), ...Array.from({ length: 200 }, (_, i) => rec(`x${i}`, i + 2, "tool-result", { textHash: "z", textBytes: 1 })), result("far", 300, "h", 100)]),
	);
	assert.equal(metric(s, D2, "duplicateDeliveries"), 1);
	assert.equal(metric(s, D2, "duplicateBytes"), 100);
	assert.equal(metric(s, D1, "duplicateDeliveries"), undefined);
	const ev = dayRow(s, D2).evidence.find((e) => e.kind === "duplicate-delivery");
	assert.deepEqual(ev, { kind: "duplicate-delivery", session: "eq", line: 2, relatedLine: 1 });
	const card = workflowInsights(s, D2, D2).find((c) => c.kind === "duplicate-delivery");
	assert.ok(card);
	assert.doesNotMatch(card.headline + card.detail, /unnecessary|avoidable read/i);
	assert.match(card.detail, /avoidab/);
});

test("handoff: abort without later final is observed on the abort day, removed by a later final, including in a resumed conversation", () => {
	const ab = (id, line, extra = {}) => asst(id, line, { stop: "aborted", ...extra });
	const fin = (id, line, extra = {}) => asst(id, line, { stop: "stop", finalText: true, ...extra });
	const s = snap(
		input("open", [ab("a1", 1)]),
		input("closed", [ab("b1", 1), fin("b2", 2, { at: T2 })]),
		input("endsText", [ab("c1", 1), asst("c2", 2, { stop: "stop", finalText: false })]),
		input("errOnly", [asst("d1", 1, { stop: "error", providerError: true })]),
		input("active", [asst("e1", 1, { stop: "toolUse" })]),
		input("resumedFrom", [ab("f1", 1)]),
		input("resumedTo", [ab("f1", 1), fin("f2", 2, { parentId: "f1", at: T2 })]),
		input("noDate", [ab("g1", 1, { at: undefined })]),
	);
	// open, closed, endsText and resumedFrom count (the resumed copy is not recounted); noDate has no day.
	assert.equal(metric(s, D1, "abortedConversations"), 4);
	// only open and endsText remain; closed and the resumed history were followed by a later actual final.
	assert.equal(metric(s, D1, "abortedNoFinal"), 2);
	assert.equal(metric(s, D2, "abortedConversations"), undefined);
	const ev = dayRow(s, D1).evidence.filter((e) => e.kind === "missing-handoff").map((e) => e.session);
	assert.deepEqual(ev.sort(), ["endsText", "open"]);
});

test("verification pairs by actual call id; isError=false and printed success are not compiler success; failures are counted as facts", () => {
	const s = snap(input("v", [
		asst("a1", 1, { calls: [call("c1", { test: true }), call("c2", { test: true, filtered: true }), call("c3", { test: true, forcedExit: true }), call("c4", { test: true }), call("o", { test: false })] }),
		rec("r2", 2, "tool-result", { resultFor: "c2", isError: false, exitCode: 0 }),
		rec("r1", 3, "tool-result", { resultFor: "c1", isError: true, exitCode: 1 }),
		rec("r3", 4, "tool-result", { resultFor: "c3", timeout: true }),
		rec("rz", 5, "tool-result", { resultFor: "zzz", isError: true }),
		rec("ro", 6, "tool-result", { resultFor: "o", isError: true, exitCode: 2 }),
	]));
	assert.equal(metric(s, D1, "testCalls"), 4);
	assert.equal(metric(s, D1, "pairedTestCalls"), 3);
	assert.equal(metric(s, D1, "testExitKnown"), 2);
	assert.equal(metric(s, D1, "testExitZero"), 1);
	assert.equal(metric(s, D1, "testErrored"), 1);
	assert.equal(metric(s, D1, "testTimeouts"), 1);
	assert.equal(metric(s, D1, "testFiltered"), 1);
	assert.equal(metric(s, D1, "testForcedExit"), 1);
	const card = workflowInsights(s).find((c) => c.kind === "verification");
	assert.ok(card);
	assert.match(card.detail, /not (a )?(known )?compiler success|does not establish/i);
	assert.doesNotMatch(card.headline + card.detail, /defect|failed to|violation/i);
});

test("verification: duplicated call ids are ambiguous and are not paired", () => {
	const s = snap(input("v", [
		asst("a1", 1, { calls: [call("same", { test: true })] }),
		asst("a2", 2, { calls: [call("same", { test: true })] }),
		rec("r", 3, "tool-result", { resultFor: "same", exitCode: 0 }),
	]));
	assert.equal(metric(s, D1, "testCalls"), 2);
	assert.equal(metric(s, D1, "pairedTestCalls") ?? 0, 0);
});

test("chronology: ordering only; test-named paths and unknown path naming are not nonTestNamed; baseline reads are observations", () => {
	const s = snap(
		input("m", [
			asst("a", 1, { calls: [call("w1", { mutation: true, testNamedPath: false }), call("w2", { mutation: true, testNamedPath: true }), call("w3", { mutation: true }), call("rd", { baselineRead: true })] }),
			asst("b", 2, { calls: [call("t1", { test: true })] }),
			asst("c", 3, { calls: [call("t2", { test: true })] }),
		]),
		input("tfirst", [asst("a", 1, { calls: [call("t", { test: true })] }), asst("b", 2, { calls: [call("w", { mutation: true, testNamedPath: false })] })]),
	);
	assert.equal(metric(s, D1, "mutations"), 4);
	assert.equal(metric(s, D1, "nonTestNamedMutations"), 2);
	assert.equal(metric(s, D1, "firstTestAfterMutation"), 1);
	assert.equal(metric(s, D1, "baselineReads"), 1);
	const card = workflowInsights(s).find((c) => c.kind === "chronology");
	assert.ok(card);
	assert.match(card.detail, /ordering/);
	assert.doesNotMatch(card.headline + card.detail, /violation|waste/i);
});

test("startup: system and first user bytes before the first request; independent identical policies both count; resumed copies do not; missing bytes stay unknown", () => {
	const mk = (p, extra = {}) => [rec(`${p}s`, 1, "system", { textBytes: 100, textHash: "pol", ...extra }), rec(`${p}u`, 2, "user", { textBytes: 40, parentId: `${p}s` }), asst(`${p}a`, 3, { parentId: `${p}u` })];
	const same = [rec("sys", 1, "system", { textBytes: 100, textHash: "pol" }), rec("usr", 2, "user", { textBytes: 40, parentId: "sys" }), asst("ast", 3, { parentId: "usr" })];
	const s = snap(
		input("one", mk("a")),
		input("two", mk("b")),
		input("origin", same),
		input("resumed", [...same, asst("more", 4, { parentId: "ast" })]),
		input("unknown", [rec("us", 1, "system", {}), rec("uu", 2, "user", { textBytes: 4 }), asst("ua", 3)]),
		input("late", [rec("ls", 1, "system", { textBytes: 9 }), asst("la", 2), rec("lu", 3, "user", { textBytes: 77 })]),
	);
	assert.equal(metric(s, D1, "startupConversations"), 3);
	assert.equal(metric(s, D1, "startupSystemBytes"), 300);
	assert.equal(metric(s, D1, "startupTaskBytes"), 120);
	const card = workflowInsights(s).find((c) => c.kind === "startup");
	assert.match(card.detail, /not provider tokens/);
});

test("identical ids across independent conversations: absent ids never collide, identical ids with different content stay distinct", () => {
	const s = snap(
		input("x", [rec("", 1, "notice", { wakeHash: "w" }), rec("", 2, "notice", { wakeHash: "w" })]),
		input("y", [rec("", 1, "notice", { wakeHash: "w" })]),
	);
	assert.equal(metric(s, D1, "wakeGroups"), 1);
	assert.equal(metric(s, D1, "wakeCopies"), 2);
	const t = snap(input("p", [asst("same", 1)]), input("q", [asst("same", 1), asst("same", 1, { usage: full({ input: 99 }) })]));
	assert.equal(metric(t, D1, "assistantRecords"), 2);
});

test("roles: declared preamble role only; ambiguous or absent roles are unknown; counters require all four parts; valuation is partial coverage", () => {
	const s = snap(
		input("r1", [rec("r1s", 1, "system", { role: "reviewer" }), asst("r1a", 2, { usage: full({ cost: 0.5, reasoning: 2 }) }), asst("r1b", 3, { usage: { input: 1, output: 1, cacheRead: 1 } })]),
		input("r2", [rec("r2s", 1, "system", { role: "reviewer" }), rec("r2u", 2, "user", { role: "builder" }), asst("r2a", 3, { usage: full({ cost: 0 }) })]),
		input("r3", [asst("r3a", 1, { role: "late", usage: full() }), rec("r3u", 2, "user", { role: "late" })]),
		input("r4", [rec("r4s", 1, "system", { role: "builder" }), asst("r4a", 2, { usage: full({ cost: 1.25 }) })]),
	);
	const row = (role) => s.roles.find((r) => r.day === D1 && r.role === role);
	assert.equal(row("reviewer").requests, 2);
	assert.equal(row("reviewer").cost, 0.5);
	assert.equal(row("reviewer").costKnown, 1);
	assert.equal(row("reviewer").tokensKnown, 1);
	assert.equal(row("reviewer").input, 10);
	assert.equal(row("reviewer").reasoning, 2);
	assert.equal(row("reviewer").reasoningKnown, 1);
	assert.equal(row("unknown").requests, 2);
	assert.equal(row("builder").requests, 1);
	assert.equal(row("builder").cost, 1.25);
	assert.equal(row("late"), undefined);
	const card = workflowInsights(s).find((c) => c.kind === "roles");
	assert.ok(card);
	assert.match(card.detail, /not an invoice/);
	assert.doesNotMatch(card.headline + card.detail, /billing|saving|waste/i);
});

test("copied records are charged once across a resumed history", () => {
	const base = [rec("s", 1, "system", { role: "r" }), asst("a1", 2, { usage: full({ cost: 1 }) }), asst("a2", 3, { usage: full({ cost: 2 }) })];
	const s = snap(input("orig", base), input("resume", [...base, asst("a3", 4, { usage: full({ cost: 4 }) })]));
	const row = s.roles.find((r) => r.role === "r" && r.day === D1);
	assert.equal(row.requests, 3);
	assert.equal(row.cost, 7);
	assert.equal(metric(s, D1, "assistantRecords"), 3);
});

test("compaction: parent-linked path, before/after prompt footprints, unknown counters and ambiguous branches are not verified", () => {
	const a = (id, line, parentId, usage) => asst(id, line, { parentId, usage: usage ?? full() });
	const s = snap(
		input("ok", [a("ok-a1", 1, undefined, { input: 100, cacheRead: 50, cacheWrite: 10, output: 1 }), rec("ok-c1", 2, "compaction", { parentId: "ok-a1" }), rec("ok-u", 3, "user", { parentId: "ok-c1" }), a("ok-a2", 4, "ok-u", { input: 20, cacheRead: 0, cacheWrite: 5, output: 1 })]),
		input("unknown", [a("un-a1", 1, undefined, { input: 100, cacheRead: 50, output: 1 }), rec("un-c1", 2, "compaction", { parentId: "un-a1" }), a("un-a2", 3, "un-c1")]),
		input("branch", [a("br-a1", 1), rec("br-c1", 2, "compaction", { parentId: "br-a1" }), a("br-b1", 3, "br-c1"), a("br-b2", 4, "br-c1")]),
		input("interleaved", [a("il-a1", 1), a("il-x1", 2, "il-a1"), rec("il-c1", 3, "compaction", { parentId: "il-a1" }), a("il-a2", 4, "il-c1"), a("il-x2", 5, "il-x1")]),
		input("nolink", [a("nl-a1", 1), rec("nl-c1", 2, "compaction"), a("nl-a2", 3)]),
		input("mixed", [a("mx-a1", 1), a("mx-a0", 2, "mx-a1"), rec("mx-c1", 3, "compaction"), a("mx-a2", 4, "mx-a0")]),
		input("twice", [a("tw-a1", 1), rec("tw-c1", 2, "compaction"), rec("tw-c2", 3, "compaction"), a("tw-a2", 4)]),
	);
	assert.equal(metric(s, D1, "compactions"), 8);
	assert.equal(metric(s, D1, "compactionPairs"), 3); // ok (linked), interleaved (linked), nolink (linear)
	assert.equal(metric(s, D1, "beforePrompt"), 160 + 15 + 15);
	assert.equal(metric(s, D1, "afterPrompt"), 25 + 15 + 15);
	const card = workflowInsights(s).find((c) => c.kind === "compaction");
	assert.ok(card);
	assert.match(card.detail, /no latency|not.*latency|does not.*latency/i);
});

test("telemetry: missing, zero and malformed counters are distinguished; opaque and capped coverage is disclosed", () => {
	const s = snap(
		input("t", [
			asst("a", 1, { usage: full({ cost: 0, reasoning: 0 }) }),
			asst("b", 2, { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			asst("c", 3, { usage: undefined }),
			asst("d", 4, { usage: { input: -1, output: Number.NaN, cacheRead: Infinity, cacheWrite: 1, cost: -3 } }),
			asst("e", 5, { at: undefined }),
			rec("o", 6, "opaque"),
		], 5),
		input("none", []),
	);
	assert.equal(metric(s, D1, "assistantRecords"), 4);
	assert.equal(metric(s, D1, "tokenComplete"), 2);
	assert.equal(metric(s, D1, "costComplete"), 1);
	assert.equal(metric(s, D1, "reasoningComplete"), 1);
	assert.equal(metric(s, D1, "opaqueRecords"), 1);
	const card = workflowInsights(s).find((c) => c.kind === "telemetry");
	assert.ok(card);
	assert.match(card.detail, /5 .*omitted|omitted.* 5/i);
	assert.match(card.detail, /incomplete/i);
	assert.match(card.detail, /unknown/i);
});

test("unknown dates never become today and do not enter any day", () => {
	const s = snap(input("u", [asst("a", 1, { at: undefined }), asst("b", 2, { at: 0 }), asst("c", 3, { at: Number.NaN }), asst("d", 4, { at: "x" })]));
	assert.deepEqual(s.days, []);
	assert.deepEqual(s.roles, []);
	assert.equal(s.coverage.filesWithRecords, 1);
});

test("insights use only the selected period; all-history counts do not leak into a single day; denominators stay independent", () => {
	const s = snap(input("p", [
		asst("a", 1, { stop: "error", providerError: true }),
		asst("b", 2, { at: T2 }),
		asst("c", 3, { at: T2 }),
		rec("n", 4, "notice", { wakeHash: "w", at: T2 }),
		rec("n2", 5, "notice", { wakeHash: "w", at: T2 }),
	]));
	const d1 = workflowInsights(s, D1, D1);
	const d2 = workflowInsights(s, D2, D2);
	const all = workflowInsights(s);
	const text = (cards) => cards.map((c) => `${c.headline} ${c.detail}`).join("\n");
	assert.match(text(d1), /1 assistant/);
	assert.match(text(d2), /2 assistant/);
	assert.match(text(all), /3 assistant/);
	assert.equal(d1.find((c) => c.kind === "wakes-errors")?.detail.includes("later cop"), false);
	assert.match(d2.find((c) => c.kind === "wakes-errors").detail, /1 later cop/);
	assert.deepEqual(workflowInsights(s, "2030-01-01", "2030-01-02"), []);
	assert.deepEqual(workflowInsights(s, D2, D1), []);
});

test("all nine lenses can be produced as at most nine grouped cards, each kind once, with neutral prose", () => {
	const s = snap(input("all", [
		rec("sys", 1, "system", { textBytes: 10, role: "worker" }),
		rec("u", 2, "user", { textBytes: 5, parentId: "sys", wakeHash: "w" }),
		rec("u2", 3, "user", { wakeHash: "w", textBytes: 1 }),
		rec("n", 4, "notice", { deliveryHash: "h", deliveryBytes: 8 }),
		asst("a1", 5, { parentId: "u", calls: [call("t", { test: true }), call("m", { mutation: true, testNamedPath: false })] }),
		rec("r", 6, "tool-result", { resultFor: "t", exitCode: 0, textHash: "h", textBytes: 8 }),
		rec("c", 7, "compaction", { parentId: "a1" }),
		asst("a2", 8, { parentId: "c", stop: "aborted" }),
	]));
	const cards = workflowInsights(s);
	assert.deepEqual(cards.map((c) => c.kind).sort(), ["chronology", "compaction", "duplicate-delivery", "missing-handoff", "roles", "startup", "telemetry", "verification", "wakes-errors"]);
	assert.ok(cards.length <= 9);
	for (const c of cards) assert.doesNotMatch(`${c.headline} ${c.detail}`, /waste|saving|billing|should|recommend|excerpt/i);
});

test("evidence is bounded to three per kind per day and 256 total, with session and physical lines but no excerpts", () => {
	const many = Array.from({ length: 40 }, (_, i) => rec(`n${i}`, i + 1, "notice", { wakeHash: "w" }));
	const s = snap(input("bounded", many));
	const ev = dayRow(s, D1).evidence.filter((e) => e.kind === "wakes-errors");
	assert.equal(ev.length, 3);
	for (const e of ev) assert.deepEqual(Object.keys(e).sort().filter((k) => !["relatedLine"].includes(k)), ["kind", "line", "session"]);

	const inputs = Array.from({ length: 300 }, (_, i) => {
		const t = new Date(2026, 1, 1 + (i % 100), 12).getTime() + i;
		return input(`s${i}`, [rec("a", 1, "notice", { wakeHash: `h${i % 2}`, at: t }), rec("b", 2, "notice", { wakeHash: `h${i % 2}`, at: t })]);
	});
	const big = buildWorkflowSnapshot(inputs);
	const total = big.days.reduce((n, d) => n + d.evidence.length, 0);
	assert.equal(total, 256);
	for (const d of big.days) {
		const per = new Map();
		for (const e of d.evidence) per.set(e.kind, (per.get(e.kind) ?? 0) + 1);
		for (const n of per.values()) assert.ok(n <= 3);
	}
});

// ---- repair round 1 ------------------------------------------------------------------
const sess = (id, line, extra = {}) => rec(id, line, "session", extra);

test("real Pi fork: different headers, shared root metadata and downstream ids, rewritten parents; copies charged once and later final resolves the shared abort", () => {
	const orig = [
		sess("hdr-1", 1, { at: T1 }),
		rec("mc", 2, "metadata", { parentId: undefined }),
		rec("th", 3, "metadata", { parentId: "mc" }),
		rec("fu", 4, "user", { parentId: "th", textBytes: 10 }),
		asst("fa1", 5, { parentId: "fu", usage: full({ cost: 1 }), calls: [call("fc", { test: true })] }),
		asst("fa2", 6, { parentId: "fa1", stop: "aborted", usage: full({ cost: 2 }) }),
	];
	// Copies keep id, content and timestamp; only line numbers, header and parent links change.
	const fork = [
		sess("hdr-2", 1, { at: T2 }),
		rec("mc", 2, "metadata", { parentId: null, at: T1 + 2 }),
		rec("fu", 3, "user", { parentId: "mc", textBytes: 10, at: T1 + 4 }),
		asst("fa1", 4, { parentId: "fu", usage: full({ cost: 1 }), calls: [call("fc", { test: true })], at: T1 + 5 }),
		asst("fa2", 5, { parentId: "fa1", stop: "aborted", usage: full({ cost: 2 }), at: T1 + 6 }),
		asst("fa3", 6, { parentId: "fa2", stop: "stop", finalText: true, usage: full({ cost: 4 }), at: T2 }),
	];
	// metadata copy differs only by physical position/parent; keep the same content.
	const s = snap(input("orig", orig), input("fork", fork));
	assert.equal(metric(s, D1, "assistantRecords"), 2);
	assert.equal(metric(s, D2, "assistantRecords"), 1);
	assert.equal(metric(s, D1, "testCalls"), 1);
	assert.equal(s.roles.reduce((n, r) => n + r.cost, 0), 7);
	assert.equal(metric(s, D1, "abortedConversations"), 1);
	assert.equal(metric(s, D1, "abortedNoFinal"), 0);
	assert.equal(s.coverage.opaqueRecords ?? 0, 0);
});

test("independent fresh startup policies with identical text are counted separately; empty-content zero system is unmeasured; forks do not recount", () => {
	const fresh = (p) => [rec(`${p}-s`, 1, "system", { textBytes: 120, textHash: "pol" }), rec(`${p}-u`, 2, "user", { textBytes: 30 }), asst(`${p}-a`, 3)];
	const zero = [rec("z-s", 1, "system", { textBytes: 0 }), rec("z-u", 2, "user", { textBytes: 30 }), asst("z-a", 3)];
	const s = snap(input("f1", fresh("f1")), input("f2", fresh("f2")), input("zero", zero), input("fork", fresh("f1")));
	assert.equal(metric(s, D1, "startupConversations"), 2);
	assert.equal(metric(s, D1, "startupSystemBytes"), 240);
	assert.equal(metric(s, D1, "startupTaskBytes"), 60);
});

test("roles: only initial system and the FIRST user declare a role; later users, session records and assistants never do", () => {
	const s = snap(
		input("a", [rec("a-sess", 1, "session", { role: "from-title" }), rec("a-u1", 2, "user", { role: "builder" }), rec("a-u2", 3, "user", { role: "other" }), asst("a-a", 4)]),
		input("b", [rec("b-u1", 1, "user", {}), rec("b-u2", 2, "user", { role: "second" }), asst("b-a", 3)]),
		input("c", [rec("c-sess", 1, "session", { role: "title" }), asst("c-a", 2)]),
	);
	const names = s.roles.map((r) => r.role).sort();
	assert.deepEqual(names, ["builder", "unknown"]);
	assert.equal(s.roles.find((r) => r.role === "unknown").requests, 2);
});

test("opaque: undated genuinely uninspected records reach global coverage; known metadata and context edits are not opaque; coverage-only payload yields a telemetry card", () => {
	const s = snap(input("o", [rec("o1", 1, "opaque", { at: undefined }), rec("m1", 2, "metadata"), rec("e1", 3, "context-edit"), rec("o2", 4, "opaque", { at: undefined })]));
	assert.equal(s.coverage.opaqueRecords, 2);
	assert.deepEqual(s.days, []);
	const card = workflowInsights(s).find((c) => c.kind === "telemetry");
	assert.ok(card, "coverage-only payload still yields a telemetry card");
	assert.match(card.detail, /2 .*opaque|opaque.* 2/i);
	assert.match(card.detail, /incomplete/i);
	const known = snap(input("k", [rec("m1", 1, "metadata"), rec("e1", 2, "context-edit"), asst("a", 3)]));
	assert.equal(known.coverage.opaqueRecords ?? 0, 0);
	assert.doesNotMatch(workflowInsights(known).find((c) => c.kind === "telemetry").detail, /incomplete/i);
	const omitted = snap({ sessionId: "x", capture: { version: 1, records: [], omittedRecords: 7 } });
	assert.match(workflowInsights(omitted, "2030-01-01", "2030-01-02").find((c) => c.kind === "telemetry").detail, /7 records omitted/);
});

test("prose: timeouts are a recorded flag, never a known zero; baseline reads are literal git-show commands; plural bodies", () => {
	const s = snap(input("p", [
		asst("p1", 1, { calls: [call("c1", { test: true }), call("b", { baselineRead: true })] }),
		rec("p2", 2, "tool-result", { resultFor: "c1", exitCode: 0 }),
	]));
	const v = workflowInsights(s).find((c) => c.kind === "verification").detail;
	assert.doesNotMatch(v, /\d+ timed out/);
	assert.match(v, /recorded timeout (flag|marker)/);
	assert.match(v, /does not show that none occurred|not.*none/);
	assert.match(workflowInsights(s).find((c) => c.kind === "chronology").detail, /git show/);
	const dd = (n) => snap(input("d", Array.from({ length: n }, (_, i) => [rec(`n${i}`, i * 2 + 1, "notice", { deliveryHash: `h${i}`, deliveryBytes: 5 }), rec(`r${i}`, i * 2 + 2, "tool-result", { textHash: `h${i}`, textBytes: 5 })]).flat()));
	const one = workflowInsights(dd(1)).find((c) => c.kind === "duplicate-delivery").headline;
	const two = workflowInsights(dd(2)).find((c) => c.kind === "duplicate-delivery").headline;
	assert.match(one, /1 delivery body\b/);
	assert.match(two, /2 delivery bodies/);
	assert.doesNotMatch(one + two, /bodys/);
});

test("evidence cap is allocated newest-day-first", () => {
	const inputs = Array.from({ length: 100 }, (_, i) => {
		const t = new Date(2026, 1, 1 + i, 12).getTime();
		return input(`s${i}`, [rec(`a${i}`, 1, "notice", { wakeHash: `u${i}`, at: t }), rec(`b${i}`, 2, "notice", { wakeHash: `u${i}`, at: t }),
			rec(`c${i}`, 3, "notice", { wakeHash: `u${i}`, at: t }), rec(`d${i}`, 4, "notice", { wakeHash: `u${i}`, at: t }),
			asst(`e${i}`, 5, { at: t, stop: "aborted" }), asst(`f${i}`, 6, { at: t, calls: [call(`k${i}`, { test: true })] })]);
	});
	const s = buildWorkflowSnapshot(inputs);
	assert.equal(s.days.reduce((n, d) => n + d.evidence.length, 0), 256);
	const newest = s.days[s.days.length - 1];
	const oldest = s.days[0];
	assert.ok(newest.evidence.length >= 3);
	assert.equal(oldest.evidence.length, 0);
});

test("context edits invalidate compaction pairs in linked and unlinked paths", () => {
	const a = (id, line, parentId) => asst(id, line, { parentId });
	const linked = snap(input("lk", [a("lk-a1", 1), rec("lk-e", 2, "context-edit", { parentId: "lk-a1" }), rec("lk-c", 3, "compaction", { parentId: "lk-e" }), a("lk-a2", 4, "lk-c")]));
	const linkedAfter = snap(input("la", [a("la-a1", 1), rec("la-c", 2, "compaction", { parentId: "la-a1" }), rec("la-e", 3, "context-edit", { parentId: "la-c" }), a("la-a2", 4, "la-e")]));
	const before = snap(input("ub", [a("ub-a1", 1), rec("ub-e", 2, "context-edit"), rec("ub-c", 3, "compaction"), a("ub-a2", 4)]));
	const after = snap(input("ua", [a("ua-a1", 1), rec("ua-c", 2, "compaction"), rec("ua-e", 3, "context-edit"), a("ua-a2", 4)]));
	const clean = snap(input("cl", [a("cl-a1", 1), rec("cl-c", 2, "compaction"), a("cl-a2", 3)]));
	for (const x of [linked, linkedAfter, before, after]) {
		assert.equal(metric(x, D1, "compactions"), 1);
		assert.equal(metric(x, D1, "compactionPairs"), 0);
	}
	assert.equal(metric(clean, D1, "compactionPairs"), 1);
});

test("stress: deep ancestry is linear, copied sources are deduplicated in aggregate, identity does not depend on parent links", () => {
	const n = 20000;
	const chain = (rewrite) => Array.from({ length: n }, (_, i) => asst(`deep${i}`, i + 1, { parentId: i === 0 ? undefined : rewrite ? `deep${i - 1}` : `deep${i - 1}`, usage: full({ cost: 1 }) }));
	const rewritten = chain().map((r, i) => ({ ...r, parentId: i === 0 ? null : `renamed${i}` }));
	const start = process.hrtime.bigint();
	const s = snap(input("d1", chain()), input("d2", chain()), input("d3", rewritten));
	const ms = Number(process.hrtime.bigint() - start) / 1e6;
	assert.equal(metric(s, D1, "assistantRecords") ?? 0 + (metric(s, D2, "assistantRecords") ?? 0), n);
	assert.equal(s.roles.reduce((t, r) => t + r.requests, 0), n);
	assert.ok(ms < 5000, `aggregation took ${ms}ms`);
});
