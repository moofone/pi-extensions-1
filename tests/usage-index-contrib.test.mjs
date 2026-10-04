// ContributionTracker: incremental contributions must equal the from-scratch reference after every step,
// deltas must be minimal, and an append must cost O(appended).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { collectUsageDataLegacy, parseSessionBuffer } from "../usage-extension/data.ts";
import { buildContributions, ContributionTracker } from "../usage-extension/index/contrib.ts";
import { UsageLedger } from "../usage-extension/index/ledger.ts";
import { compareCanonical } from "../usage-extension/index/types.ts";
import { fallbackSessionId } from "../usage-extension/sources.ts";
import { appendTurns, assertUsageDataEqual, makeHistory, sessionLines } from "./usage-index-support.mjs";

const NOW = new Date(2026, 9, 1, 16, 17, 0);

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

async function loadRecord(path) {
	const st = statSync(path);
	const parsed = await parseSessionBuffer(await readFile(path));
	parsed.sessionId = fallbackSessionId("pi", path, parsed.sessionId);
	return { path, kind: "pi", size: st.size, mtimeMs: st.mtimeMs, resume: null, parsed };
}

function walk(dir) {
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

// --- delta application ---------------------------------------------------------------------------

function applyDelta(map, delta) {
	if (delta.reset) map.clear();
	for (const p of delta.removed) map.delete(p);
	for (const c of delta.replaced) map.set(c.path, { ...c, counted: [...c.counted] });
	for (const a of delta.appended) {
		const f = map.get(a.path);
		assert.ok(f, `appended entry for unknown file ${a.path}`);
		f.counted.push(...a.counted);
	}
}

function normalizeContribs(list) {
	return [...list].sort(compareCanonical).map((c) => ({
		path: c.path,
		kind: c.kind,
		sessionId: c.sessionId,
		project: c.project,
		counted: c.counted.map((x) => ({ msg: x.msg, meta: x.meta, miss: x.miss })),
	}));
}

function assertDeltaPaths(delta) {
	const seen = new Set();
	for (const list of [delta.replaced.map((c) => c.path), delta.appended.map((a) => a.path), delta.removed]) {
		for (const p of list) {
			assert.ok(!seen.has(p), `path in two delta lists: ${p}`);
			seen.add(p);
		}
	}
}

// --- nested tool usage fixtures ------------------------------------------------------------------

function nestedLine({ id, ts, runId, reported, children }) {
	const u = (v) => ({ input: v, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: v / 10 } });
	return (
		JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(ts).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName: "subagent",
				content: [{ type: "text", text: "done" }],
				details: {
					mode: children.length > 1 ? "parallel" : "single",
					runId,
					results: children.map((c, i) => ({ agent: `a${i}`, task: "t", exitCode: 0, usage: { ...u(c.v).input !== undefined ? { input: c.v, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: c.v / 10, turns: 1 } : {} }, ...(c.sessionFile ? { sessionFile: c.sessionFile } : {}) })),
				},
				...(reported ? { usage: u(reported) } : {}),
				isError: false,
				timestamp: ts,
			},
		}) + "\n"
	);
}

// --- the property test ---------------------------------------------------------------------------

for (const seed of [1, 2, 3, 4, 5]) {
	test(`tracker deltas reproduce the reference contributions and the legacy snapshot (seed ${seed})`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "usage-contrib-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const sessionsDir = join(root, "sessions");
		const r = rng(seed * 7919);
		const files = new Set(makeHistory(sessionsDir, { seed, sessions: 8, now: NOW.getTime() }));
		const records = new Map();
		const tracker = new ContributionTracker();
		const applied = new Map();
		const ledger = new UsageLedger();
		const tally = { appended: 0, replaced: 0, removed: 0, reset: 0, empty: 0 };
		let counter = 0;

		const step = async (label, upsertPaths, removedPaths, kinds = {}) => {
			const upserts = [];
			for (const p of upsertPaths) {
				const old = records.get(p);
				const record = await loadRecord(p);
				let change = { type: "full" };
				if (kinds[p] === "append" && old) change = { type: "append", messagesFrom: old.parsed.messages.length, toolUsagesFrom: old.parsed.toolUsages.length };
				records.set(p, record);
				upserts.push({ record, change });
			}
			for (const p of removedPaths) records.delete(p);
			const delta = tracker.update({ upserts, removed: removedPaths });
			assertDeltaPaths(delta);
			if (delta.reset) tally.reset++;
			tally.appended += delta.appended.length;
			tally.replaced += delta.replaced.length;
			tally.removed += delta.removed.length;
			if (!delta.reset && !delta.replaced.length && !delta.appended.length && !delta.removed.length) tally.empty++;
			applyDelta(applied, delta);
			ledger.apply(delta);
			assert.deepEqual([...records.keys()].sort(), walk(sessionsDir).sort(), `${label}: records vs disk`);
			assert.deepEqual(normalizeContribs(applied.values()), normalizeContribs(buildContributions(records)), `${label}: contributions`);
			assert.equal(tracker.size, records.size);
			assertUsageDataEqual(ledger.snapshot(NOW), await collectUsageDataLegacy({ sessionsDir, cachePath: null, now: NOW }), `${label}: snapshot`);
		};

		await step("initial", [...files], []);

		const pick = () => [...files][Math.floor(r() * files.size)];
		for (let i = 0; i < 60; i++) {
			const op = Math.floor(r() * 10);
			const label = `seed ${seed} step ${i} op ${op}`;
			if (op <= 2 && files.size > 0) {
				// append (often to branched copies, which duplicate history)
				const p = pick();
				appendTurns(p, 1 + Math.floor(r() * 5), seed * 100 + i, NOW.getTime() - 3600_000 + i * 1000);
				await step(label, [p], [], { [p]: "append" });
			} else if (op === 3) {
				// brand-new file, maybe a branched copy of an existing one (duplicate history under the same session id)
				const dir = join(sessionsDir, `--Users-me-Dev-git-new${counter % 3}--`);
				mkdirSync(dir, { recursive: true });
				const p = join(dir, `new-${counter++}.jsonl`);
				if (files.size > 0 && r() < 0.6) {
					const src = (await readFile(pick(), "utf8")).split("\n").filter(Boolean);
					const keep = src.slice(0, Math.max(1, Math.floor(src.length * (0.3 + r() * 0.6))));
					writeFileSync(p, keep.join("\n") + "\n" + sessionLines({ id: "x", cwd: "/x", start: NOW.getTime() - 1000, turns: 2, seed: i }).text.split("\n").slice(1).join("\n"));
				} else {
					writeFileSync(p, sessionLines({ id: `n${seed}-${counter}`, cwd: "/Users/me/Dev/git/n", start: NOW.getTime() - Math.floor(r() * 20) * 86_400_000, turns: 3 + Math.floor(r() * 10), seed: seed * 31 + i }).text);
				}
				files.add(p);
				await step(label, [p], []);
			} else if (op === 4 && files.size > 0) {
				// rewrite with different content (maybe a different session id)
				const p = pick();
				const id = r() < 0.5 ? undefined : `rw${seed}-${i}`;
				const text = sessionLines({ id: id ?? "keep", cwd: "/Users/me/Dev/git/rw", start: NOW.getTime() - 5 * 86_400_000, turns: 2 + Math.floor(r() * 8), seed: seed * 977 + i }).text;
				writeFileSync(p, id ? text : text.replace('"id":"keep"', `"id":"${(await loadRecord(p)).parsed.sessionId}"`));
				await step(label, [p], []);
			} else if (op === 5 && files.size > 2) {
				const p = pick();
				rmSync(p);
				files.delete(p);
				await step(label, [], [p]);
			} else if (op === 6) {
				// parent with nested tool usage; child session files come and go
				const dir = join(sessionsDir, "--Users-me-Dev-git-nested--");
				mkdirSync(dir, { recursive: true });
				const stem = `parent-${counter++}`;
				const parent = join(dir, `${stem}.jsonl`);
				const runId = `run-${i}`;
				const explicitChild = join(dir, `explicit-${counter++}.jsonl`);
				const lines = [JSON.stringify({ type: "session", version: 3, id: `par${seed}-${i}`, timestamp: new Date(NOW.getTime() - 4000).toISOString(), cwd: "/Users/me/Dev/git/nested" }) + "\n"];
				lines.push(nestedLine({ id: `rep${i}`, ts: NOW.getTime() - 3000, runId, reported: 40, children: [{ v: 20 }, { v: 20, sessionFile: explicitChild }] }));
				lines.push(nestedLine({ id: `leg${i}`, ts: NOW.getTime() - 2000, runId: `${runId}-b`, reported: null, children: [{ v: 30 }, { v: 31, sessionFile: join(dir, "nowhere.jsonl") }] }));
				writeFileSync(parent, lines.join(""));
				files.add(parent);
				await step(label + " parent", [parent], []);
				const kids = [];
				const derived = join(dir, stem, runId, "run-0", "session.jsonl");
				mkdirSync(dirname(derived), { recursive: true });
				const childSpecs = [[derived, `kid${seed}-${i}`, i + 5]];
				if (r() < 0.7) childSpecs.push([explicitChild, `ekid${seed}-${i}`, i + 9]);
				for (const [k, id, sd] of childSpecs) {
					writeFileSync(k, sessionLines({ id, cwd: "/Users/me/Dev/git/nested", start: NOW.getTime() - 3500, turns: 2, seed: sd }).text);
					kids.push(k);
					files.add(k);
					await step(label + " child " + k.slice(-30), [k], []);
				}
				if (r() < 0.6) {
					const k = kids[Math.floor(r() * kids.length)];
					rmSync(k);
					files.delete(k);
					await step(label + " child removed", [], [k]);
				}
				if (r() < 0.4) {
					// the parent grows another nested result
					appendFileSync(parent, nestedLine({ id: `more${i}`, ts: NOW.getTime() - 1000, runId: `${runId}-c`, reported: 12, children: [{ v: 12 }] }));
					await step(label + " parent grows", [parent], [], { [parent]: "append" });
				}
			} else if (op === 7) {
				// a file whose provider reports cache tokens appears / disappears (provider-set change)
				const dir = join(sessionsDir, "--Users-me-Dev-git-rep--");
				mkdirSync(dir, { recursive: true });
				const p = join(dir, "reporter.jsonl");
				if (files.has(p)) {
					rmSync(p);
					files.delete(p);
					await step(label + " reporter gone", [], [p]);
				} else {
					const line = (id, ts, cr) => JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(ts).toISOString(), message: { role: "assistant", content: [], provider: "cursor", model: "auto", usage: { input: 30000, output: 100, cacheRead: cr, cacheWrite: 0, reasoning: 0, cost: { total: 0.1 } }, timestamp: ts } }) + "\n";
					writeFileSync(p, JSON.stringify({ type: "session", version: 3, id: "reporter", timestamp: new Date(NOW.getTime() - 9000).toISOString(), cwd: "/x" }) + "\n" + line("r1", NOW.getTime() - 8000, 50000));
					files.add(p);
					await step(label + " reporter", [p], []);
				}
			} else if (op === 8 && files.size > 0) {
				// size/mtime moved, nothing new parsed
				const p = pick();
				const rec = await loadRecord(p);
				const old = records.get(p);
				const delta = tracker.update({ upserts: [{ record: { ...rec, parsed: old.parsed, size: old.size + 3 }, change: { type: "none" } }], removed: [] });
				assert.equal(delta.reset, false);
				assert.deepEqual([delta.replaced.length, delta.appended.length, delta.removed.length], [0, 0, 0], "none → empty delta");
				records.set(p, { ...rec, parsed: old.parsed, size: old.size + 3 });
			} else {
				// batch: several appends + a delete at once
				const ps = [...files].filter(() => r() < 0.3).slice(0, 4);
				for (const p of ps) appendTurns(p, 2, seed * 5 + i, NOW.getTime() - 1800_000 + i * 500);
				const gone = files.size > ps.length + 2 ? [...files].find((f) => !ps.includes(f) && r() < 0.5) : undefined;
				if (gone) {
					rmSync(gone);
					files.delete(gone);
				}
				await step(label + " batch", ps, gone ? [gone] : [], Object.fromEntries(ps.map((p) => [p, "append"])));
			}
		}
		// Sanity: the random run exercised every delta kind.
		assert.ok(tally.appended > 0 && tally.replaced > 0 && tally.removed > 0, JSON.stringify(tally));
		assert.ok(tally.reset > 0, "provider-set changes must reset: " + JSON.stringify(tally));
	});
}

// --- minimality ----------------------------------------------------------------------------------

function asst(ts, sourceId = "", over = {}) {
	return { provider: "anthropic", model: "m", thinkingLevel: "", source: "assistant", sourceId, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, reasoning: 0, cost: 1, timestamp: ts, afterCompaction: false, ...over };
}

function rec(path, messages, sessionId = path, toolUsages = []) {
	return { path, kind: "pi", size: 1, mtimeMs: 1, resume: null, parsed: { sessionId, cwd: "/x", messages, toolUsages } };
}

const FULL = { type: "full" };

test("pure appends are reported as appended entries only, with prev adjacency across the cut", () => {
	const tr = new ContributionTracker();
	const a0 = rec("/a.jsonl", [asst(1000), asst(2000)]);
	const first = tr.update({ upserts: [{ record: a0, change: FULL }], removed: [] });
	assert.equal(first.replaced.length, 1);
	const a1 = rec("/a.jsonl", [...a0.parsed.messages, asst(3000, "", { cacheRead: 0, model: "n" })]);
	const d = tr.update({ upserts: [{ record: a1, change: { type: "append", messagesFrom: 2, toolUsagesFrom: 0 } }], removed: [] });
	assert.deepEqual([d.reset, d.replaced.length, d.removed.length, d.appended.length], [false, 0, 0, 1]);
	const [c] = d.appended[0].counted;
	assert.equal(c.meta.gapMs, 1000);
	assert.equal(c.meta.modelSwitched, true);
	assert.equal(c.meta.isSessionStart, false);
	assert.equal(c.miss, null); // prevCtx 110 < 20k
	assert.equal(a1.parsed.messages[2].provider, "anthropic");
});

test("ownership: earlier file takes a message → later owner replaced; removal hands it back", () => {
	const tr = new ContributionTracker();
	const shared = asst(5000, "dup");
	const b = rec("/b.jsonl", [asst(1000), shared], "s");
	tr.update({ upserts: [{ record: b, change: FULL }], removed: [] });
	const a0 = rec("/a.jsonl", [asst(500)], "s");
	let d = tr.update({ upserts: [{ record: a0, change: FULL }], removed: [] });
	// a holds only a unique first message; its session starts earlier than b's, so b's start flag moves → b replaced.
	assert.deepEqual(d.replaced.map((c) => c.path), ["/a.jsonl", "/b.jsonl"]);
	// a (earlier) now appends the shared message: b loses it → replaced, a only appended.
	const a1 = rec("/a.jsonl", [asst(500), shared], "s");
	d = tr.update({ upserts: [{ record: a1, change: { type: "append", messagesFrom: 1, toolUsagesFrom: 0 } }], removed: [] });
	assert.deepEqual(d.appended.map((x) => x.path), ["/a.jsonl"]);
	assert.deepEqual(d.replaced.map((c) => c.path), ["/b.jsonl"]);
	assert.equal(d.replaced[0].counted.length, 1);
	// remove a: b regains the message (replaced), session start moves to b's first assistant... b is the only holder.
	d = tr.update({ upserts: [], removed: ["/a.jsonl"] });
	assert.deepEqual(d.removed, ["/a.jsonl"]);
	assert.deepEqual(d.replaced.map((c) => c.path), ["/b.jsonl"]);
	assert.equal(d.replaced[0].counted.length, 2);
	assert.equal(d.replaced[0].counted[0].meta.isSessionStart, true);
});

test("append to one file leaves other files untouched, even in a shared session", () => {
	const tr = new ContributionTracker();
	const a = rec("/a.jsonl", [asst(100)], "s");
	const b = rec("/b.jsonl", [asst(200)], "s");
	tr.update({ upserts: [{ record: a, change: FULL }, { record: b, change: FULL }], removed: [] });
	const b2 = rec("/b.jsonl", [asst(200), asst(300)], "s");
	const d = tr.update({ upserts: [{ record: b2, change: { type: "append", messagesFrom: 1, toolUsagesFrom: 0 } }], removed: [] });
	assert.deepEqual([d.replaced.length, d.removed.length, d.appended.length], [0, 0, 1]);
});

test("a changed cache-reporting provider set resets with every contribution", () => {
	const tr = new ContributionTracker();
	const a = rec("/a.jsonl", [asst(1000, "", { provider: "anthropic" })]);
	const b = rec("/b.jsonl", [asst(1000, "", { provider: "cursor", cacheRead: 0 })]);
	tr.update({ upserts: [{ record: a, change: FULL }, { record: b, change: FULL }], removed: [] });
	const b2 = rec("/b.jsonl", [asst(1000, "", { provider: "cursor", cacheRead: 0 }), asst(2000, "", { provider: "cursor", cacheRead: 7 })]);
	const d = tr.update({ upserts: [{ record: b2, change: { type: "append", messagesFrom: 1, toolUsagesFrom: 0 } }], removed: [] });
	assert.equal(d.reset, true);
	assert.deepEqual(d.replaced.map((c) => c.path), ["/a.jsonl", "/b.jsonl"]);
});

test("adding a scanned child session replaces only the parent whose tool messages change", () => {
	const tr = new ContributionTracker();
	const tool = { sourceId: "t1", timestamp: 900, reportedUsage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 2 }, runId: "", children: [{ resultIndex: 0, sessionFile: "/kid.jsonl", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 2 } }] };
	const parent = rec("/p.jsonl", [asst(800)], "p", [tool]);
	const other = rec("/o.jsonl", [asst(850)], "o");
	let d = tr.update({ upserts: [{ record: parent, change: FULL }, { record: other, change: FULL }], removed: [] });
	assert.equal(d.replaced.find((c) => c.path === "/p.jsonl").counted.length, 2);
	d = tr.update({ upserts: [{ record: rec("/kid.jsonl", [asst(890)], "kid"), change: FULL }], removed: [] });
	assert.deepEqual(d.replaced.map((c) => c.path).sort(), ["/kid.jsonl", "/p.jsonl"]);
	assert.equal(d.replaced.find((c) => c.path === "/p.jsonl").counted.length, 1);
	d = tr.update({ upserts: [], removed: ["/kid.jsonl"] });
	assert.deepEqual(d.removed, ["/kid.jsonl"]);
	// The parent only regains its (trailing) tool message: an append, not a rewrite.
	assert.deepEqual([d.replaced.length, d.appended.map((a) => a.path)], [0, ["/p.jsonl"]]);
});

test("input records are never mutated", () => {
	const tr = new ContributionTracker();
	const m = asst(1000, "", { provider: "zcode-re" });
	const snapshot = JSON.stringify(m);
	tr.update({ upserts: [{ record: rec("/a.jsonl", [m]), change: FULL }], removed: [] });
	assert.equal(JSON.stringify(m), snapshot);
});

// --- performance ---------------------------------------------------------------------------------

test("an append of 5 messages among 25k records costs O(appended)", () => {
	const tr = new ContributionTracker();
	const N = 25_000;
	const recs = [];
	for (let i = 0; i < N; i++) {
		const base = 1_700_000_000_000 + i * 100_000;
		recs.push(rec(`/p/${String(i).padStart(6, "0")}.jsonl`, [asst(base), asst(base + 1000), asst(base + 2000), asst(base + 3000)], `s${i}`));
	}
	let t0 = performance.now();
	const cold = tr.update({ upserts: recs.map((record) => ({ record, change: FULL })), removed: [] });
	const coldMs = performance.now() - t0;
	assert.equal(cold.replaced.length, N);
	const target = recs[N >> 1];
	const grown = rec(target.path, [...target.parsed.messages, ...[1, 2, 3, 4, 5].map((k) => asst(9_000_000_000_000 + k * 1000))], target.parsed.sessionId);
	const samples = [];
	let cur = target;
	for (let rep = 0; rep < 5; rep++) {
		const next = rep === 0 ? grown : rec(cur.path, [...cur.parsed.messages, ...[1, 2, 3, 4, 5].map((k) => asst(9_100_000_000_000 + rep * 100_000 + k * 1000))], cur.parsed.sessionId);
		t0 = performance.now();
		const d = tr.update({ upserts: [{ record: next, change: { type: "append", messagesFrom: cur.parsed.messages.length, toolUsagesFrom: 0 } }], removed: [] });
		samples.push(performance.now() - t0);
		assert.deepEqual([d.reset, d.replaced.length, d.appended.length, d.appended[0].counted.length], [false, 0, 1, 5]);
		cur = next;
	}
	console.log(`contrib perf: cold ${N} records ${coldMs.toFixed(0)} ms; append(5) ${samples.map((s) => s.toFixed(3)).join(", ")} ms`);
	assert.ok(Math.min(...samples) < 5, `append took ${samples}`);
});
