import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getAgentDir, saveUsageCache } from "../usage-extension/data.ts";
import { Discoverer, discoverFiles } from "../usage-extension/index/discover.ts";
import { defaultKindOf, openIndexStore, shardOf, SHARD_COUNT } from "../usage-extension/index/store.ts";
import { compareCanonical } from "../usage-extension/index/types.ts";
import { collectJsonlFiles, collectNamedFiles, collectOpenCodeMessageFiles, parseUsageSourcesSetting } from "../usage-extension/sources.ts";
import { appendTurns, makeHistory } from "./usage-index-support.mjs";

function tmp(t) {
	const dir = mkdtempSync(join(tmpdir(), "usage-store-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const msg = (i, extra = {}) => ({
	provider: "anthropic",
	model: "claude-opus-5-5",
	thinkingLevel: "high",
	source: "assistant",
	sourceId: "",
	cost: 0.1 * i + 0.00000000012345,
	input: 10 + i,
	output: 20,
	cacheRead: 300,
	cacheWrite: 40,
	timestamp: 1_700_000_000_000 + i * 1000,
	reasoning: 5,
	afterCompaction: i % 2 === 0,
	costInput: 0.01234567891234,
	costOutput: 0.2,
	costCacheRead: 0.003,
	costCacheWrite: 0.004,
	cacheWrite1h: 7,
	...extra,
});

const zero = { costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, cacheWrite1h: 0 };

function record(path, i, kind = "pi", withResume = true) {
	return {
		path,
		kind,
		size: 1000 + i,
		mtimeMs: 1_700_000_000_123.5 + i,
		resume: withResume ? { offset: 900 + i, headHash: "a".repeat(40), tailHash: "b".repeat(40), state: { sessionId: `s${i}`, cwd: "/x/é", nested: { level: "high", n: [1, 2] } } } : null,
		parsed: {
			sessionId: `s${i}`,
			cwd: "/Users/me/proj",
			messages: [
				msg(i),
				msg(i + 1, { ...zero, source: "auxiliary", sourceId: "tool-entry", provider: "Tools", model: "summaries", thinkingLevel: "Tools/summaries" }),
				msg(i + 2, { cacheWrite1h: 0 }),
			],
			toolUsages: [
				{ sourceId: "t1", timestamp: 5, reportedUsage: { cost: 0.5, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 }, runId: "run1", children: [] },
				{ sourceId: "t2", timestamp: 6, reportedUsage: null, runId: "run2", children: [{ resultIndex: 1, sessionFile: "/child.jsonl", usage: { cost: 0.25, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] },
			],
		},
	};
}

function normalizeRecord(r) {
	// The store (like the v7 cache) materialises the five optional cost fields as 0.
	return JSON.parse(JSON.stringify({ ...r, parsed: { ...r.parsed, messages: r.parsed.messages.map((m) => ({ ...zero, ...m })) } }));
}

function shardFiles(dir) {
	return readdirSync(dir).filter((f) => /^shard-\d\d\.json$/.test(f));
}

test("store round-trips records (resume/state/kind/tool usages) through shards", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	assert.equal((await store.load()).size, 0);
	const kinds = ["pi", "claude-code", "codex-cli", "grok-build", "opencode-go"];
	const records = Array.from({ length: 40 }, (_, i) => record(`/data/s/${i}/file-${i}.jsonl`, i, kinds[i % 5], i % 3 !== 0));
	for (const r of records) store.put(r);
	await store.flush();
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), { version: 8, shards: 64 });

	const loaded = await openIndexStore(dir).load();
	assert.equal(loaded.size, records.length);
	for (const r of records) assert.deepEqual(normalizeRecord(loaded.get(r.path)), normalizeRecord(r), r.path);
	// Full float precision survives (no 1e-9 rounding).
	assert.equal(loaded.get(records[0].path).parsed.messages[0].costInput, 0.01234567891234);
});

test("flush rewrites only dirty shards and is cheap when clean", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	await store.load();
	const records = Array.from({ length: 300 }, (_, i) => record(`/data/p${i % 17}/f${i}.jsonl`, i));
	for (const r of records) store.put(r);
	await store.flush();
	assert.equal(shardFiles(dir).length, SHARD_COUNT);

	const mtimes = () => Object.fromEntries(shardFiles(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));
	await new Promise((r) => setTimeout(r, 30));
	const before = mtimes();
	await store.flush(); // clean
	assert.deepEqual(mtimes(), before);

	const victim = records[5];
	store.put({ ...victim, size: victim.size + 1 });
	await store.flush();
	const after = mtimes();
	const changed = Object.keys(after).filter((f) => after[f] !== before[f]);
	assert.deepEqual(changed, [`shard-${String(shardOf(victim.path)).padStart(2, "0")}.json`]);

	store.delete(records[9].path);
	await store.flush();
	const afterDelete = mtimes();
	assert.equal(Object.keys(afterDelete).filter((f) => afterDelete[f] !== after[f]).length, 1);
	const loaded = await openIndexStore(dir).load();
	assert.equal(loaded.size, 299);
	assert.equal(loaded.get(victim.path).size, victim.size + 1);
	assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("concurrent flushes are serialised and the final state is complete", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	await store.load();
	const flushes = [];
	for (let i = 0; i < 60; i++) {
		store.put(record(`/c/f${i}.jsonl`, i));
		flushes.push(store.flush());
	}
	await Promise.all(flushes);
	await store.flush();
	assert.equal((await openIndexStore(dir).load()).size, 60);
	// Overlapping flush calls while one runs share one queued run.
	store.put(record("/c/extra.jsonl", 99));
	const a = store.flush();
	const b = store.flush();
	const c = store.flush();
	assert.equal(b, c);
	await Promise.all([a, b, c]);
	assert.equal((await openIndexStore(dir).load()).size, 61);
});

test("flush never throws (unwritable directory) and retries later", async (t) => {
	const dir = tmp(t);
	const blocker = join(dir, "blocked");
	writeFileSync(blocker, "not a dir");
	const store = openIndexStore(join(blocker, "store"));
	await store.load();
	store.put(record("/a.jsonl", 1));
	await store.flush(); // must not reject
	await store.writeRollup({ a: 1 }); // best effort
});

test("corrupt, unknown-version and misplaced shards are dropped; others survive", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	await store.load();
	const records = Array.from({ length: 200 }, (_, i) => record(`/q/f${i}.jsonl`, i));
	for (const r of records) store.put(r);
	await store.flush();
	const [s1, s2, s3] = [...new Set(records.map((r) => shardOf(r.path)))];
	const name = (n) => join(dir, `shard-${String(n).padStart(2, "0")}.json`);
	writeFileSync(name(s1), "{ not json");
	writeFileSync(name(s2), JSON.stringify({ version: 99, shard: s2, names: [], files: {} }));
	const raw = JSON.parse(readFileSync(name(s3), "utf8"));
	const firstPath = Object.keys(raw.files)[0];
	raw.files[firstPath] = [1, 2]; // one bad file entry only
	writeFileSync(name(s3), JSON.stringify(raw));

	const reopened = openIndexStore(dir);
	const loaded = await reopened.load();
	const lost = new Set(records.filter((r) => [s1, s2].includes(shardOf(r.path)) || r.path === firstPath).map((r) => r.path));
	assert.ok(lost.size > 0);
	assert.equal(loaded.size, records.length - lost.size);
	for (const r of records) assert.equal(loaded.has(r.path), !lost.has(r.path));
	// Dropped shards are rewritten on the next flush; reparsed files are put back.
	for (const r of records) if (lost.has(r.path)) reopened.put(r);
	await reopened.flush();
	assert.equal((await openIndexStore(dir).load()).size, records.length);
});

test("a corrupt manifest means no store: stale shards are never trusted", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	await store.load();
	for (let i = 0; i < 20; i++) store.put(record(`/m/f${i}.jsonl`, i));
	await store.flush();
	writeFileSync(join(dir, "manifest.json"), "garbage");
	const reopened = openIndexStore(dir);
	assert.equal((await reopened.load()).size, 0);
	reopened.put(record("/m/only.jsonl", 1));
	await reopened.flush();
	const loaded = await openIndexStore(dir).load();
	assert.deepEqual([...loaded.keys()], ["/m/only.jsonl"]);
});

function legacyCache(path, files, version) {
	const names = [];
	const idx = (n) => {
		let i = names.indexOf(n);
		if (i < 0) names.push(n), (i = names.length - 1);
		return i;
	};
	const out = {};
	for (const [p, f] of Object.entries(files)) {
		out[p] = {
			size: f.size,
			mtimeMs: f.mtimeMs,
			sessionId: f.sessionId,
			cwd: f.cwd,
			messages: f.messages.map((m) => [idx(m.provider), idx(m.model), m.cost, m.input, m.output, m.cacheRead, m.cacheWrite, m.timestamp, idx(""), 0, 0, 0, idx("")]),
			toolUsages: [],
		};
	}
	writeFileSync(path, JSON.stringify({ version, names, files: out }));
}

test("legacy v6 cache (13-field tuples) is imported once with resume null and kind heuristics", async (t) => {
	const dir = tmp(t);
	const legacy = join(dir, "legacy.json");
	const mk = (sessionId) => ({ size: 10, mtimeMs: 20, sessionId, cwd: "/w", messages: [{ provider: "p", model: "m", cost: 1.5, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, timestamp: 6 }] });
	legacyCache(legacy, { "/h/.pi/agent/sessions/a.jsonl": mk("a"), "/h/.claude/projects/b.jsonl": mk("b"), "/h/.codex/sessions/c.jsonl": mk("c") }, 6);
	const before = readFileSync(legacy, "utf8");
	const storeDir = join(dir, "idx");
	const store = openIndexStore(storeDir, { legacyCachePath: legacy });
	const loaded = await store.load();
	assert.equal(loaded.size, 3);
	assert.equal(loaded.get("/h/.pi/agent/sessions/a.jsonl").kind, "pi");
	assert.equal(loaded.get("/h/.claude/projects/b.jsonl").kind, "claude-code");
	assert.equal(loaded.get("/h/.codex/sessions/c.jsonl").kind, "codex-cli");
	for (const r of loaded.values()) assert.equal(r.resume, null);
	assert.equal(loaded.get("/h/.claude/projects/b.jsonl").parsed.messages[0].cost, 1.5);
	await store.flush();
	assert.equal(readFileSync(legacy, "utf8"), before, "legacy file untouched");
	// Second open reads v8 only: delete the legacy file and it still loads.
	rmSync(legacy);
	assert.equal((await openIndexStore(storeDir, { legacyCachePath: legacy }).load()).size, 3);
});

test("legacy v7 cache imports through kindOf; v8 store wins afterwards", async (t) => {
	const dir = tmp(t);
	const legacy = join(dir, "legacy.json");
	const states = new Map();
	for (const i of [1, 2]) states.set(`/x/${i}.jsonl`, { size: i, mtimeMs: i, parsed: record(`/x/${i}.jsonl`, i).parsed });
	await saveUsageCache(legacy, states);
	const storeDir = join(dir, "idx");
	const store = openIndexStore(storeDir, { legacyCachePath: legacy, kindOf: (p) => (p.endsWith("1.jsonl") ? "grok-build" : null) });
	const loaded = await store.load();
	assert.equal(loaded.get("/x/1.jsonl").kind, "grok-build");
	assert.equal(loaded.get("/x/2.jsonl").kind, "pi");
	assert.equal(loaded.get("/x/1.jsonl").parsed.toolUsages.length, 2);
	await store.flush();
	assert.equal(shardFiles(storeDir).length, SHARD_COUNT);
	// An existing v8 store is not re-imported.
	const again = openIndexStore(storeDir, { legacyCachePath: legacy, kindOf: () => "codex-cli" });
	assert.equal((await again.load()).get("/x/1.jsonl").kind, "grok-build");
	assert.equal(defaultKindOf("/a/.grok/b/updates.jsonl"), "grok-build");
	assert.equal(defaultKindOf("/a/opencode/storage/message/ses_1/msg_2.json"), "opencode-go");
});

test("memory-only store (dir null) keeps records and the rollup", async (t) => {
	const store = openIndexStore(null);
	assert.equal((await store.load()).size, 0);
	store.put(record("/a.jsonl", 1));
	store.put(record("/b.jsonl", 2));
	store.delete("/a.jsonl");
	await store.flush();
	assert.deepEqual([...(await store.load()).keys()], ["/b.jsonl"]);
	assert.equal(await store.readRollup(), null);
	await store.writeRollup({ k: [1, 2] });
	assert.deepEqual(await store.readRollup(), { k: [1, 2] });
});

test("rollup round-trips atomically on disk", async (t) => {
	const dir = tmp(t);
	const store = openIndexStore(dir);
	assert.equal(await store.readRollup(), null);
	await store.writeRollup({ a: { b: [1, 2, 3] } });
	assert.deepEqual(await openIndexStore(dir).readRollup(), { a: { b: [1, 2, 3] } });
	await store.writeRollup({ replaced: true });
	assert.deepEqual(await openIndexStore(dir).readRollup(), { replaced: true });
	assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The scaffold implementation: legacy walkers + stat. */
async function referenceDiscover(sessionsDir, sources) {
	const seen = new Map();
	const add = (paths, kind) => {
		for (const p of paths) if (!seen.has(p)) seen.set(p, kind);
	};
	add(await collectJsonlFiles(sessionsDir), "pi");
	const scans = [
		{ ...sources.claudeCode, kind: "claude-code", list: collectJsonlFiles },
		{ ...sources.codexCli, kind: "codex-cli", list: collectJsonlFiles },
		{ ...sources.grokBuild, kind: "grok-build", list: (r) => collectNamedFiles(r, "updates.jsonl") },
		{ ...sources.opencodeGo, kind: "opencode-go", list: collectOpenCodeMessageFiles },
	];
	for (const s of scans) if (s.enabled) for (const root of s.roots) add(await s.list(root), s.kind);
	const out = [];
	for (const [path, kind] of seen) {
		try {
			const st = statSync(path);
			out.push({ path, kind, size: st.size, mtimeMs: st.mtimeMs });
		} catch {}
	}
	return out.sort(compareCanonical);
}

const noSources = { claudeCode: { enabled: false, roots: [] }, codexCli: { enabled: false, roots: [] }, grokBuild: { enabled: false, roots: [] }, opencodeGo: { enabled: false, roots: [] } };

function writeSource(root, rel, text = "{}\n") {
	const p = join(root, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, text);
	return p;
}

test("discovery equals the legacy walkers on a synthetic multi-source tree (incl. overlap, symlinks, odd names)", async (t) => {
	const root = tmp(t);
	const sessionsDir = join(root, "sessions");
	makeHistory(sessionsDir, { seed: 3, sessions: 10 });
	writeSource(sessionsDir, "x/notes.txt");
	writeSource(sessionsDir, "x/y/z/deep.jsonl");
	writeSource(sessionsDir, "x/dir.jsonl/inner.jsonl");
	mkdirSync(join(sessionsDir, "empty"), { recursive: true });
	symlinkSync(join(sessionsDir, "x/y/z/deep.jsonl"), join(sessionsDir, "x/link.jsonl"));
	symlinkSync(join(sessionsDir, "x"), join(sessionsDir, "linkdir"));
	const claude = join(root, ".claude/projects");
	writeSource(claude, "p1/a.jsonl");
	writeSource(claude, "p1/sub/b.jsonl");
	const codex = join(root, ".codex/sessions");
	writeSource(codex, "2026/10/01/rollout-1.jsonl");
	writeSource(sessionsDir, "overlap.jsonl"); // also under the claude root below → first kind (pi) wins
	const grok = join(root, ".grok/sessions");
	writeSource(grok, "w/s1/updates.jsonl");
	writeSource(grok, "w/s1/other.jsonl");
	const oc1 = join(root, "oc1");
	writeSource(oc1, "storage/message/ses_1/msg_a.json");
	writeSource(oc1, "storage/message/ses_1/msg_b.json.bak");
	writeSource(oc1, "storage/message/ses_1/note.json");
	const oc2 = join(root, "oc2/storage");
	writeSource(oc2, "message/ses_2/msg_c.json");
	const oc3 = join(root, "oc3/storage/message/");
	writeSource(oc3, "ses_3/msg_d.json");
	const sources = {
		claudeCode: { enabled: true, roots: [claude, sessionsDir] },
		codexCli: { enabled: true, roots: [codex, join(root, "missing-root")] },
		grokBuild: { enabled: true, roots: [grok] },
		opencodeGo: { enabled: true, roots: [oc1, oc2, join(root, "oc3") + "/"] },
	};
	for (const s of [sources, noSources]) {
		const expected = await referenceDiscover(sessionsDir, s);
		assert.deepEqual(await discoverFiles({ sessionsDir, sources: s }), expected);
		assert.deepEqual(await new Discoverer().discover({ sessionsDir, sources: s }), expected);
	}
	const all = await discoverFiles({ sessionsDir, sources });
	assert.ok(all.some((f) => f.kind === "opencode-go") && all.some((f) => f.kind === "grok-build") && all.some((f) => f.kind === "claude-code"));
	assert.equal(all.find((f) => f.path.endsWith("overlap.jsonl")).kind, "pi");
	assert.deepEqual(await discoverFiles({ sessionsDir: join(root, "nope"), sources: noSources }), []);
	const ac = new AbortController();
	ac.abort();
	assert.equal(await discoverFiles({ sessionsDir, sources, signal: ac.signal }), null);
});

test("Discoverer reuses directory listings while the directory mtime is unchanged and sees changes", async (t) => {
	const root = tmp(t);
	const sessionsDir = join(root, "sessions");
	const files = makeHistory(sessionsDir, { seed: 5, sessions: 8 });
	// Age every directory so listings are outside the racy window.
	const old = new Date(Date.now() - 3_600_000);
	const ageDirs = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) ageDirs(join(d, e.name));
		utimesSync(d, old, old);
	};
	ageDirs(sessionsDir);
	const d = new Discoverer();
	const opts = { sessionsDir, sources: noSources };
	const first = await d.discover(opts);
	assert.deepEqual(first, await referenceDiscover(sessionsDir, noSources));
	const dirCount = d.misses;
	assert.ok(dirCount >= 2 && d.hits === 0);

	// Unchanged directories: all hits; stat info is still fresh (an append shows up).
	appendTurns(files[0], 2, 11);
	const second = await d.discover(opts);
	assert.equal(d.misses, dirCount);
	assert.equal(d.hits, dirCount);
	assert.deepEqual(second, await referenceDiscover(sessionsDir, noSources));
	assert.notEqual(second.find((f) => f.path === files[0]).size, first.find((f) => f.path === files[0]).size);

	// A new file in one directory (mtime changes) is found; only that directory is re-listed.
	const added = writeSource(join(files[0], ".."), "added.jsonl");
	const missesBefore = d.misses;
	const third = await d.discover(opts);
	assert.ok(third.some((f) => f.path === added));
	assert.equal(d.misses - missesBefore, 1);
	assert.deepEqual(third, await referenceDiscover(sessionsDir, noSources));

	// Deleting a file / directory disappears.
	rmSync(added);
	rmSync(join(files[0], ".."), { recursive: true });
	assert.deepEqual(await d.discover(opts), await referenceDiscover(sessionsDir, noSources));
});

test("discovery equals the legacy walkers on the real history (read-only)", async (t) => {
	const sessionsDir = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return t.skip("no real history");
	let sources = noSources;
	try {
		sources = parseUsageSourcesSetting(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
	} catch {}
	void homedir;
	const expected = await referenceDiscover(sessionsDir, sources);
	const actual = await discoverFiles({ sessionsDir, sources });
	// The real history is live (sessions get created/appended between the scans): tolerate a few changes.
	const ref = new Map(expected.map((f) => [f.path, f]));
	const got = new Map(actual.map((f) => [f.path, f]));
	const onlyRef = [...ref.keys()].filter((p) => !got.has(p));
	const onlyGot = [...got.keys()].filter((p) => !ref.has(p));
	assert.ok(onlyRef.length + onlyGot.length <= 20, `path set differs: -${onlyRef.length} +${onlyGot.length}`);
	let same = 0;
	for (const [p, f] of got) {
		const r = ref.get(p);
		if (!r) continue;
		assert.equal(f.kind, r.kind, p);
		if (f.size === r.size && f.mtimeMs === r.mtimeMs) same++;
	}
	assert.ok(same >= actual.length - 40, `${same}/${actual.length} identical stats`);
	const d = new Discoverer();
	const cold = await d.discover({ sessionsDir, sources });
	const warm = await d.discover({ sessionsDir, sources });
	assert.ok(Math.abs(cold.length - actual.length) <= 20 && Math.abs(warm.length - actual.length) <= 20);
});
