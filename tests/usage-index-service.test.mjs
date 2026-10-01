// Service lane: UsageIndexCore orchestration, the worker host (client.ts), pool, watch, idle TTL, singleton.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectUsageData, collectUsageDataLegacy } from "../usage-extension/data.ts";
import { getUsageIndex, inspectUsageIndex } from "../usage-extension/index/client.ts";
import { UsageIndexCore } from "../usage-extension/index/service.ts";
import { appendTurns, assertUsageDataEqual, makeHistory, sessionLines } from "./usage-index-support.mjs";

const NOW = new Date(2026, 9, 1, 16, 17, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(t, sessions = 14, seed = 7) {
	const root = mkdtempSync(join(tmpdir(), "usage-index-svc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionsDir = join(root, "sessions");
	const files = makeHistory(sessionsDir, { seed, sessions, now: NOW.getTime() });
	return { root, sessionsDir, storeDir: join(root, "store"), files };
}

const legacy = (sessionsDir, extra = {}) => collectUsageDataLegacy({ sessionsDir, cachePath: null, now: NOW, ...extra });
const coreOptions = (f, extra = {}) => ({ sessionsDir: f.sessionsDir, storeDir: f.storeDir, legacyCachePath: null, worker: false, watch: false, parseWorkers: 0, ...extra });

async function waitFor(fn, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(25);
	}
	return false;
}

test("core equals legacy: fresh, appends, new file, rewrite, delete — and a second core on the same store", async (t) => {
	const f = fixture(t);
	const core = new UsageIndexCore(coreOptions(f));
	t.after(() => core.dispose());
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "fresh");

	appendTurns(f.files[0], 5, 99, NOW.getTime() - 900_000);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "append");

	const fresh = join(f.sessionsDir, "--Users-me-Dev-git-proj0--", "new-session.jsonl");
	writeFileSync(fresh, sessionLines({ id: "brand-new", cwd: "/Users/me/Dev/git/proj0", start: NOW.getTime() - 3_000_000, turns: 6, seed: 4242 }).text);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "new file");

	// Rewrite: different (shorter) content.
	writeFileSync(f.files[2], sessionLines({ id: "rewritten", cwd: "/Users/me/Dev/git/proj2", start: NOW.getTime() - 7_200_000, turns: 4, seed: 31 }).text);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "rewrite");

	rmSync(f.files[1]);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "delete");

	await core.flush();
	const second = new UsageIndexCore(coreOptions(f));
	t.after(() => second.dispose());
	assertUsageDataEqual(await second.snapshot({ now: NOW }), await legacy(f.sessionsDir), "second core on the persisted store");
});

test("core: a different `now` re-buckets the same index", async (t) => {
	const f = fixture(t);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null }));
	t.after(() => core.dispose());
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "now");
	const later = new Date(NOW.getTime() + 3 * 86_400_000);
	assertUsageDataEqual(await core.snapshot({ now: later }), await collectUsageDataLegacy({ sessionsDir: f.sessionsDir, cachePath: null, now: later }), "later");
});

test("core: abort mid-refresh returns null and the next snapshot still equals legacy", async (t) => {
	const f = fixture(t, 140, 11);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null }));
	t.after(() => core.dispose());
	const pre = new AbortController();
	pre.abort();
	assert.equal(await core.snapshot({ now: NOW, signal: pre.signal }), null);

	const controller = new AbortController();
	let events = 0;
	const aborted = await core.snapshot({
		now: NOW,
		signal: controller.signal,
		onProgress: (p) => {
			events++;
			if (p.filesParsed >= 40) controller.abort();
		},
	});
	assert.equal(aborted, null);
	assert.ok(events >= 1);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "after abort");
	rmSync(f.files[3]);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "after abort + delete");
});

test("core: progress events carry first-run / update / rebuild semantics", async (t) => {
	const f = fixture(t, 6);
	const collect = async (core) => {
		const events = [];
		await core.snapshot({ now: NOW, onProgress: (p) => events.push(p) });
		return events;
	};
	const core = new UsageIndexCore(coreOptions(f));
	t.after(() => core.dispose());
	let events = await collect(core);
	assert.equal(events[0].mode, "first-run");
	assert.equal(events[0].filesToParse, f.files.length);
	assert.equal(events[0].filesParsed, 0);
	assert.equal(events[0].sinceMs, null);
	assert.equal(events.at(-1).filesParsed, f.files.length);

	events = await collect(core);
	assert.equal(events.length, 1);
	assert.deepEqual([events[0].mode, events[0].filesToParse], ["update", 0]);

	const newest = Math.max(...f.files.map((p) => statSync(p).mtimeMs));
	appendTurns(f.files[0], 2, 5, NOW.getTime() - 1000);
	events = await collect(core);
	assert.equal(events[0].mode, "update");
	assert.equal(events[0].filesToParse, 1);
	assert.equal(events[0].sinceMs, newest);

	// An unusable legacy cache with nothing in the store → "rebuild".
	const stale = join(f.root, "stale.json");
	writeFileSync(stale, JSON.stringify({ version: 1, names: [], files: {} }));
	events = await collect(new UsageIndexCore(coreOptions(f, { storeDir: join(f.root, "store2"), legacyCachePath: stale })));
	assert.equal(events[0].mode, "rebuild");
	assert.equal(events[0].sinceMs, null);
});

test("core: a big batch goes through the parse pool and equals legacy", async (t) => {
	const f = fixture(t, 30, 21);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null, parseWorkers: 3 }), { poolThreshold: 5 });
	t.after(() => core.dispose());
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "pool");
	appendTurns(f.files[4], 3, 8, NOW.getTime() - 1000);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "pool then append");
});

test("core: the pool falls back in-thread when its workers cannot run", async (t) => {
	const f = fixture(t, 12, 5);
	const bad = join(f.root, "bad-worker.mjs");
	writeFileSync(bad, "throw new Error('no thanks');\n");
	const { ParsePool } = await import("../usage-extension/index/pool.ts");
	const pool = ParsePool.tryCreate(2, bad);
	t.after(() => pool?.close());
	if (pool) {
		const file = { path: f.files[0], kind: "pi", size: statSync(f.files[0]).size, mtimeMs: 0 };
		assert.equal(await pool.parse(file, null), "failed");
		assert.equal(await pool.parse(file, null), "failed");
	}
});

test("collectUsageData is a thin incremental wrapper and keeps no state without a cache", async (t) => {
	const f = fixture(t, 8);
	const cachePath = join(f.root, "cache.json");
	const a = await collectUsageData({ sessionsDir: f.sessionsDir, cachePath, now: NOW });
	assertUsageDataEqual(a, await legacy(f.sessionsDir), "wrapper");
	appendTurns(f.files[0], 4, 3, NOW.getTime() - 1000);
	assertUsageDataEqual(await collectUsageData({ sessionsDir: f.sessionsDir, cachePath, now: NOW }), await legacy(f.sessionsDir), "wrapper after append");
	// cachePath null: every call is independent.
	const events = [];
	await collectUsageData({ sessionsDir: f.sessionsDir, cachePath: null, now: NOW, onProgress: (p) => events.push(p) });
	await collectUsageData({ sessionsDir: f.sessionsDir, cachePath: null, now: NOW, onProgress: (p) => events.push(p) });
	assert.deepEqual(events.filter((e) => e.filesParsed === 0).map((e) => [e.mode, e.filesToParse]), [["first-run", f.files.length], ["first-run", f.files.length]]);
});

test("worker mode returns the same snapshot, streams progress, and keeps main-thread stalls small", async (t) => {
	const f = fixture(t, 40, 3);
	const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: f.storeDir, legacyCachePath: null, worker: true, watch: false, parseWorkers: 0 });
	t.after(() => index.dispose());
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last - 10);
		last = now;
	}, 10);
	const events = [];
	const data = await index.snapshot({ now: NOW, onProgress: (p) => events.push(p) });
	clearInterval(timer);
	assert.deepEqual(inspectUsageIndex(index)?.worker, true, "ran in a worker");
	assertUsageDataEqual(data, await legacy(f.sessionsDir), "worker snapshot");
	assert.equal(events[0].mode, "first-run");
	assert.ok(worst < 250, `main-thread stall ${Math.round(worst)} ms`);
	// Warm second snapshot + append through the worker.
	appendTurns(f.files[0], 3, 9, NOW.getTime() - 1000);
	assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "worker after append");
	// Abort travels to the worker.
	const controller = new AbortController();
	controller.abort();
	assert.equal(await index.snapshot({ now: NOW, signal: controller.signal }), null);
});

test("in-thread mode (worker: false) gives the same answers and serves lastRollup", async (t) => {
	const f = fixture(t, 10);
	const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: f.storeDir, legacyCachePath: null, worker: false, watch: false, parseWorkers: 0 });
	t.after(() => index.dispose());
	assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "in-thread");
	assert.equal(inspectUsageIndex(index)?.worker, false);
	assert.ok(await waitFor(async () => (await index.lastRollup()) !== null), "rollup persisted after a snapshot");
});

test("a worker that cannot start falls back to the in-thread core", async (t) => {
	const f = fixture(t, 10);
	const bad = join(f.root, "throws.mjs");
	writeFileSync(bad, "throw new Error('boom');\n");
	const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: null, legacyCachePath: null, worker: true, watch: false, parseWorkers: 0, workerEntry: bad });
	t.after(() => index.dispose());
	assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "fallback");
	const state = inspectUsageIndex(index);
	assert.equal(state.forcedInThread, true);
	assert.equal(state.worker, false);
});

test("a worker that crashes twice falls back to the in-thread core", async (t) => {
	const f = fixture(t, 10);
	const flaky = join(f.root, "crashes.mjs");
	writeFileSync(
		flaky,
		"import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ type: 'ready' });\nparentPort.on('message', (m) => { if (m.type === 'snapshot') process.exit(3); });\n"
	);
	const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: null, legacyCachePath: null, worker: true, watch: false, parseWorkers: 0, workerEntry: flaky });
	t.after(() => index.dispose());
	assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "after two crashes");
	const state = inspectUsageIndex(index);
	assert.equal(state.crashes, 2);
	assert.equal(state.forcedInThread, true);
});

for (const worker of [true, false]) {
	test(`subscribe (worker: ${worker}): an appended file fires the listener and the next snapshot includes it`, async (t) => {
		const f = fixture(t, 8);
		const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: null, legacyCachePath: null, worker, watch: true, parseWorkers: 0 });
		t.after(() => index.dispose());
		await index.snapshot({ now: NOW });
		let fired = 0;
		const unsubscribe = index.subscribe(() => fired++);
		await sleep(400); // let the recursive watcher attach
		appendFileSync(f.files[0], sessionLines({ id: "x", cwd: "/x", start: NOW.getTime() - 5000, turns: 3, seed: 77 }).text.split("\n").slice(1).join("\n"));
		assert.ok(await waitFor(() => fired > 0), "listener fired");
		assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "snapshot after change");
		unsubscribe();
		const before = fired;
		appendTurns(f.files[1], 2, 6, NOW.getTime() - 4000);
		await sleep(1500);
		assert.equal(fired, before, "no events after unsubscribe");
	});
}

test("idle TTL releases the worker and the next call restarts it", async (t) => {
	const f = fixture(t, 6);
	const index = getUsageIndex({ sessionsDir: f.sessionsDir, storeDir: f.storeDir, legacyCachePath: null, worker: true, watch: false, parseWorkers: 0, idleTtlMs: 150 });
	t.after(() => index.dispose());
	await index.snapshot({ now: NOW });
	assert.equal(inspectUsageIndex(index).worker, true);
	assert.ok(await waitFor(() => inspectUsageIndex(index).worker === false, 4000), "worker released after the idle TTL");
	assertUsageDataEqual(await index.snapshot({ now: NOW }), await legacy(f.sessionsDir), "after restart");
	assert.equal(inspectUsageIndex(index).worker, true);

	// Subscribers keep it alive.
	const unsubscribe = index.subscribe(() => {});
	await sleep(500);
	assert.equal(inspectUsageIndex(index).worker, true);
	unsubscribe();
});

test("getUsageIndex is a process-wide singleton per option key", async (t) => {
	const f = fixture(t, 3);
	const opts = { sessionsDir: f.sessionsDir, storeDir: null, legacyCachePath: null, worker: false, watch: false };
	const a = getUsageIndex(opts);
	assert.equal(getUsageIndex({ ...opts }), a);
	const b = getUsageIndex({ ...opts, sessionsDir: join(f.root, "other") });
	assert.notEqual(a, b);
	const registry = globalThis[Symbol.for("pi-usage-index")];
	assert.ok(registry instanceof Map && registry.size >= 2);
	await a.dispose();
	await b.dispose();
	const c = getUsageIndex(opts);
	assert.notEqual(c, a);
	await c.dispose();
});

test("vanished sessions dir and mtime-only touches are handled", async (t) => {
	const f = fixture(t, 5);
	const core = new UsageIndexCore(coreOptions(f, { storeDir: null }));
	t.after(() => core.dispose());
	await core.snapshot({ now: NOW });
	const future = new Date(Date.now() + 5000);
	utimesSync(f.files[0], future, future); // size same, mtime differs → reparsed, same totals
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "touch");
	mkdirSync(join(f.sessionsDir, "empty"), { recursive: true });
	rmSync(f.sessionsDir, { recursive: true });
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(f.sessionsDir), "gone");
});
