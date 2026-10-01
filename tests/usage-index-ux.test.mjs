import assert from "node:assert/strict";
import test from "node:test";

import { createUsageFlow, progressMessage, cachedRollupOf, LOADER_DELAY_MS } from "../usage-extension/usage-flow.ts";

const ROLLUP = { generatedAt: "2026-10-01T00:00:00.000Z", days: ["2026-10-01"], keys: [["a", "m"]], reporting: [], fields: [], rows: [] };
const CACHED = { kind: "pi-hud/usage", v: 1, rollup: ROLLUP };

function fakeData(tag) {
	return { tag, hourly: new Map(), bounds: { nowMs: Date.UTC(2026, 9, 1) } };
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

/** Manual clock: timers fire only on advance(). */
function fakeClock() {
	let t = 1_000;
	const timers = new Set();
	return {
		now: () => t,
		setTimeout: (fn, ms) => {
			const timer = { at: t + ms, fn };
			timers.add(timer);
			return timer;
		},
		clearTimeout: (h) => timers.delete(h),
		advance(ms) {
			t += ms;
			for (const timer of [...timers]) {
				if (timer.at <= t) {
					timers.delete(timer);
					timer.fn();
				}
			}
		},
		pending: () => timers.size,
	};
}

const tick = () => new Promise((r) => setImmediate(r));

function harness({ cached = null, snapshots } = {}) {
	const log = [];
	const clock = fakeClock();
	const listeners = new Set();
	const calls = { snapshot: [], unsub: 0 };
	let snapshotNo = 0;
	const index = {
		lastRollup: async () => {
			log.push("lastRollup");
			return cached;
		},
		snapshot: (o) => {
			log.push("snapshot");
			calls.snapshot.push(o);
			const impl = snapshots[snapshotNo++] ?? snapshots[snapshots.length - 1];
			return impl(o);
		},
		subscribe: (fn) => {
			listeners.add(fn);
			return () => {
				calls.unsub++;
				listeners.delete(fn);
			};
		},
		dispose: async () => {},
	};
	const events = [];
	const callbacks = {
		showLoading: (m) => events.push(["showLoading", m]),
		setLoadingMessage: (m) => events.push(["setLoadingMessage", m]),
		showDashboard: (d) => events.push(["showDashboard", d.tag]),
		updateDashboard: (d) => events.push(["updateDashboard", d.tag]),
		surfaceChanged: () => events.push(["surfaceChanged"]),
		end: () => events.push(["end"]),
	};
	const flow = createUsageFlow({ index, callbacks, clock });
	return { flow, events, clock, log, listeners, calls, kinds: () => events.map((e) => e[0]) };
}

test("cached rollup is the payload (with loading) before the snapshot resolves", async () => {
	const snap = deferred();
	const h = harness({ cached: CACHED, snapshots: [() => snap.promise] });
	const initial = h.flow.surface();
	assert.ok(initial.loading && !initial.rollup, "plain loading before lastRollup resolves");
	const started = h.flow.start();
	await tick();
	assert.deepEqual(h.log, ["lastRollup", "snapshot"]);
	const p = h.flow.surface();
	assert.equal(p.kind, "pi-hud/usage");
	assert.equal(p.v, 1);
	assert.equal(p.rollup, ROLLUP);
	assert.equal(p.loading.message, "Loading Usage...");
	snap.resolve(fakeData("d1"));
	await started;
	const done = h.flow.surface();
	assert.ok(done.rollup && !done.loading, "loading cleared once data arrives");
	h.flow.close();
});

test("no cached rollup keeps the plain loading payload", async () => {
	const snap = deferred();
	const h = harness({ cached: null, snapshots: [() => snap.promise] });
	const started = h.flow.start();
	await tick();
	const p = h.flow.surface();
	assert.equal(p.rollup, undefined);
	assert.equal(p.loading.message, "Loading Usage...");
	snap.resolve(fakeData("d1"));
	await started;
	h.flow.close();
});

test("garbage lastRollup values are ignored", () => {
	assert.equal(cachedRollupOf(null), null);
	assert.equal(cachedRollupOf({ kind: "x", v: 1, rollup: ROLLUP }), null);
	assert.equal(cachedRollupOf({ kind: "pi-hud/usage", v: 1, rollup: { days: 1 } }), null);
	assert.equal(cachedRollupOf(CACHED), ROLLUP);
});

test("fast snapshot: no loader, dashboard directly", async () => {
	const h = harness({ snapshots: [async () => fakeData("d1")] });
	await h.flow.start();
	assert.ok(!h.kinds().includes("showLoading"));
	assert.ok(h.kinds().includes("showDashboard"));
	assert.equal(h.clock.pending(), 0, "loader timer cleared");
	h.clock.advance(5_000);
	assert.ok(!h.kinds().includes("showLoading"));
	h.flow.close();
});

test("slow snapshot: loader after the delay, progress messages, then dashboard", async () => {
	const snap = deferred();
	const h = harness({ snapshots: [() => snap.promise] });
	const started = h.flow.start();
	await tick();
	h.clock.advance(LOADER_DELAY_MS - 1);
	assert.ok(!h.kinds().includes("showLoading"));
	h.clock.advance(1);
	assert.deepEqual(h.events.find((e) => e[0] === "showLoading"), ["showLoading", "Loading Usage..."]);
	h.calls.snapshot[0].onProgress({ mode: "rebuild", filesParsed: 5, filesToParse: 10, sinceMs: null });
	const msg = h.events.find((e) => e[0] === "setLoadingMessage")[1];
	assert.match(msg, /Rebuilding your usage history/);
	assert.match(msg, /5\/10 files/);
	assert.equal(h.flow.surface().loading.message, msg);
	snap.resolve(fakeData("d1"));
	await started;
	const order = h.kinds();
	assert.ok(order.indexOf("showLoading") < order.indexOf("showDashboard"));
	h.flow.close();
});

test("progress with nothing to parse is ignored; same message keeps the payload object", async () => {
	assert.equal(progressMessage({ mode: "update", filesParsed: 0, filesToParse: 0, sinceMs: null }), null);
	const snap = deferred();
	const h = harness({ snapshots: [() => snap.promise] });
	const started = h.flow.start();
	await tick();
	const p = { mode: "first", filesParsed: 1, filesToParse: 3, sinceMs: null };
	h.calls.snapshot[0].onProgress(p);
	const a = h.flow.surface();
	h.calls.snapshot[0].onProgress(p);
	assert.equal(h.flow.surface(), a);
	h.calls.snapshot[0].onProgress({ ...p, filesParsed: 2 });
	assert.notEqual(h.flow.surface(), a);
	snap.resolve(fakeData("d"));
	await started;
	h.flow.close();
});

test("live update: updateDashboard with the new data and a NEW payload object", async () => {
	const h = harness({ snapshots: [async () => fakeData("d1"), async () => fakeData("d2")] });
	await h.flow.start();
	const before = h.flow.surface();
	assert.equal(h.flow.surface(), before, "memoized per data");
	assert.equal(h.listeners.size, 1);
	[...h.listeners][0]();
	await tick();
	assert.deepEqual(h.events.filter((e) => e[0] === "updateDashboard"), [["updateDashboard", "d2"]]);
	const after = h.flow.surface();
	assert.notEqual(after, before);
	assert.equal(h.flow.surface(), after);
	assert.ok(h.calls.snapshot[1].signal instanceof AbortSignal);
	h.flow.close();
	assert.equal(h.calls.unsub, 1);
	assert.equal(h.listeners.size, 0);
});

test("close during the first snapshot shows nothing and aborts", async () => {
	const snap = deferred();
	const h = harness({ snapshots: [() => snap.promise] });
	const started = h.flow.start();
	await tick();
	const signal = h.calls.snapshot[0].signal;
	h.flow.close();
	assert.equal(signal.aborted, true);
	snap.resolve(fakeData("late"));
	await started;
	assert.ok(!h.kinds().includes("showDashboard"));
	assert.ok(!h.kinds().includes("end"));
	assert.equal(h.calls.unsub, 1);
	h.clock.advance(10_000);
	assert.ok(!h.kinds().includes("showLoading"));
});

test("close during a live refresh ignores its late result", async () => {
	const live = deferred();
	const h = harness({ snapshots: [async () => fakeData("d1"), () => live.promise] });
	await h.flow.start();
	[...h.listeners][0]();
	await tick();
	const before = h.flow.surface();
	h.flow.close();
	live.resolve(fakeData("late"));
	await tick();
	assert.ok(!h.events.some((e) => e[0] === "updateDashboard"));
	assert.equal(h.flow.surface(), before);
});

test("overlapping updates are serialised and the latest wins", async () => {
	const a = deferred();
	const b = deferred();
	const h = harness({ snapshots: [async () => fakeData("d1"), () => a.promise, () => b.promise] });
	await h.flow.start();
	const notify = [...h.listeners][0];
	notify();
	await tick();
	notify();
	notify();
	await tick();
	assert.equal(h.calls.snapshot.length, 2, "no concurrent snapshot while one is in flight");
	a.resolve(fakeData("stale"));
	await tick();
	assert.equal(h.calls.snapshot.length, 3, "one trailing refresh");
	assert.ok(!h.events.some((e) => e[0] === "updateDashboard"), "stale result dropped");
	b.resolve(fakeData("latest"));
	await tick();
	assert.deepEqual(h.events.filter((e) => e[0] === "updateDashboard"), [["updateDashboard", "latest"]]);
	h.flow.close();
});

test("a change notified before the first dashboard triggers a refresh right after it", async () => {
	const snap = deferred();
	const h = harness({ snapshots: [() => snap.promise, async () => fakeData("d2")] });
	const started = h.flow.start();
	await tick();
	[...h.listeners][0]();
	snap.resolve(fakeData("d1"));
	await started;
	await tick();
	assert.deepEqual(h.kinds().filter((k) => k === "showDashboard" || k === "updateDashboard"), ["showDashboard", "updateDashboard"]);
	h.flow.close();
});

test("abort/failed first snapshot ends the flow once; thrown snapshot too", async () => {
	for (const impl of [async () => null, async () => { throw new Error("boom"); }]) {
		const h = harness({ snapshots: [impl] });
		await h.flow.start();
		assert.deepEqual(h.kinds().filter((k) => k === "end"), ["end"]);
		assert.ok(!h.kinds().includes("showDashboard"));
		assert.equal(h.calls.unsub, 1);
	}
});

test("live refresh errors and nulls leave the dashboard untouched", async () => {
	const h = harness({ snapshots: [async () => fakeData("d1"), async () => null, async () => { throw new Error("x"); }] });
	await h.flow.start();
	const notify = [...h.listeners][0];
	notify();
	await tick();
	notify();
	await tick();
	assert.ok(!h.events.some((e) => e[0] === "updateDashboard"));
	assert.ok(!h.kinds().includes("end"));
	h.flow.close();
});
