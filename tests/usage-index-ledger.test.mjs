// Ledger lane: equivalence with the legacy oracle (several seeds / nows / time zones), exact incremental
// add/remove, and a perf report. Set LEDGER_PERF_MESSAGES=1000000 for the full-size perf run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectUsageDataLegacy } from "../usage-extension/data.ts";
import { buildContributions } from "../usage-extension/index/contrib.ts";
import { UsageLedger, periodBounds } from "../usage-extension/index/ledger.ts";
import { parseFile } from "../usage-extension/index/parse.ts";
import { assertUsageDataEqual, makeHistory } from "./usage-index-support.mjs";

const SELF = fileURLToPath(import.meta.url);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- equivalence (runs in a TZ child)

async function recordsFor(dir) {
	const { readdirSync, statSync } = await import("node:fs");
	const records = new Map();
	for (const proj of readdirSync(dir)) {
		for (const name of readdirSync(join(dir, proj))) {
			const path = join(dir, proj, name);
			const st = statSync(path);
			const out = await parseFile({ path, kind: "pi", size: st.size, mtimeMs: st.mtimeMs });
			if (out) records.set(path, out.record);
		}
	}
	return records;
}

async function equivalenceScenario() {
	const nows = [
		new Date(Date.UTC(2026, 9, 1, 19, 17)),
		new Date(Date.UTC(2026, 2, 8, 20, 0)), // US/Canada spring forward
		new Date(Date.UTC(2026, 2, 9, 3, 30)),
		new Date(Date.UTC(2026, 3, 5, 10, 0)), // Lord Howe DST end
		new Date(Date.UTC(2026, 9, 4, 14, 0)), // Lord Howe DST start
		new Date(Date.UTC(2026, 10, 1, 14, 0)), // North America fall back
		new Date(Date.UTC(2026, 10, 2, 1, 30)),
	];
	let checks = 0;
	for (const now of nows) {
		for (const seed of [1, 2, 3]) {
			const root = mkdtempSync(join(tmpdir(), "usage-ledger-eq-"));
			try {
				const sessionsDir = join(root, "sessions");
				makeHistory(sessionsDir, { seed, sessions: 16, now: now.getTime() });
				const ledger = new UsageLedger();
				ledger.apply({ reset: true, replaced: buildContributions(await recordsFor(sessionsDir)), appended: [], removed: [] });
				for (const at of [now, new Date(now.getTime() + 5 * HOUR), new Date(now.getTime() - 3 * DAY)]) {
					const legacy = await collectUsageDataLegacy({ sessionsDir, cachePath: null, now: at });
					assertUsageDataEqual(ledger.snapshot(at), legacy, `tz=${process.env.TZ} now=${at.toISOString()} seed=${seed}`);
					checks++;
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	}
	console.log(JSON.stringify({ checks }));
}

if (process.env.LEDGER_TZ_CHILD) {
	await equivalenceScenario();
	process.exit(0);
}

for (const tz of ["UTC", "America/Halifax", "America/St_Johns", "Asia/Kathmandu", "Australia/Lord_Howe"]) {
	test(`ledger snapshot equals the legacy collector in ${tz}`, () => {
		const r = spawnSync(process.execPath, [...process.execArgv, SELF], { env: { ...process.env, TZ: tz, LEDGER_TZ_CHILD: "1" }, encoding: "utf8" });
		assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
		assert.ok(JSON.parse(r.stdout.trim().split("\n").pop()).checks >= 21);
	});
}

test("periodBounds matches local midnight boundaries", () => {
	const b = periodBounds(new Date(2026, 9, 1, 16, 17));
	assert.equal(b.todayMs, new Date(2026, 9, 1).getTime());
	assert.equal(b.weekStartMs, new Date(2026, 8, 28).getTime());
	assert.equal(b.lastWeekStartMs, new Date(2026, 8, 21).getTime());
	assert.equal(b.last30DaysStartMs, new Date(2026, 8, 2).getTime());
});

// ---------------------------------------------------------------- incremental

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

const PAIRS = [["anthropic", "claude-opus-5-5"], ["anthropic", "claude-sonnet-5-5"], ["openai-codex", "gpt-6-luna"], ["devin", "swe-2"], ["faux", "x"], ["Tools", "summaries"]];

function counted(r, n, t0, span) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const [provider, model] = PAIRS[Math.floor(r() * PAIRS.length)];
		const aux = provider === "Tools";
		const input = Math.floor(r() * 3000);
		const cacheRead = r() < 0.7 ? Math.floor(r() * 200_000) : 0;
		const cacheWrite = Math.floor(r() * 5000);
		const output = Math.floor(r() * 2000);
		const cost = r() < 0.1 ? 0 : (input * 5 + output * 25 + cacheRead * 0.5 + cacheWrite * 6.25) / 1e6;
		const ts = r() < 0.03 ? 0 : Math.floor(t0 + r() * span);
		const miss = !aux && r() < 0.1 ? ["ttl", "switch", "prefix"][Math.floor(r() * 3)] : null;
		out.push({
			msg: {
				provider, model, thinkingLevel: aux ? "Tools/summaries" : ["", "low", "high"][Math.floor(r() * 3)], source: aux ? "auxiliary" : "assistant", sourceId: "",
				timestamp: ts, afterCompaction: false, cost, input, output, cacheRead, cacheWrite, reasoning: Math.floor(r() * 400), cacheWrite1h: r() < 0.5 ? cacheWrite : 0,
				costInput: input * 5e-6, costOutput: output * 25e-6, costCacheRead: cacheRead * 5e-7, costCacheWrite: cacheWrite * 6.25e-6,
			},
			meta: { gapMs: 1000, prevCtx: 1000, modelSwitched: false, isSessionStart: !aux && r() < 0.05 },
			miss,
		});
	}
	return out;
}

const NOW = new Date(2026, 9, 1, 16, 17);

test("incremental replace/append/remove/reset sequences equal a ledger rebuilt from scratch", () => {
	for (const seed of [11, 12, 13, 14]) {
		const r = rng(seed);
		const t0 = NOW.getTime() - 50 * DAY;
		const span = 50 * DAY + 2 * DAY;
		const model = new Map();
		const ledger = new UsageLedger();
		const fresh = (i) => ({ path: `/s/${i}.jsonl`, kind: "pi", sessionId: `sess-${Math.floor(i / 2)}`, project: `~/p${i % 3}`, counted: counted(r, 1 + Math.floor(r() * 40), t0, span) });
		for (let step = 0; step < 150; step++) {
			const roll = r();
			const delta = { reset: false, replaced: [], appended: [], removed: [] };
			const keys = [...model.keys()];
			if (roll < 0.35) {
				const c = fresh(Math.floor(r() * 30));
				delta.replaced.push(c);
				model.set(c.path, { ...c, counted: [...c.counted] });
			} else if (roll < 0.65 && keys.length > 0) {
				const path = keys[Math.floor(r() * keys.length)];
				const add = counted(r, 1 + Math.floor(r() * 5), t0, span);
				delta.appended.push({ path, counted: add });
				model.get(path).counted.push(...add);
			} else if (roll < 0.9 && keys.length > 0) {
				const path = keys[Math.floor(r() * keys.length)];
				delta.removed.push(path);
				model.delete(path);
			} else if (roll < 0.95) {
				delta.reset = true;
				model.clear();
				for (let i = 0; i < 5; i++) {
					const c = fresh(Math.floor(r() * 30));
					delta.replaced.push(c);
					model.set(c.path, { ...c, counted: [...c.counted] });
				}
			}
			ledger.apply(delta);
			if (step % 10 === 9) {
				const rebuilt = new UsageLedger();
				rebuilt.apply({ reset: true, replaced: [...model.values()], appended: [], removed: [] });
				for (const at of [NOW, new Date(NOW.getTime() - 9 * DAY)]) assertUsageDataEqual(ledger.snapshot(at), rebuilt.snapshot(at), `seed ${seed} step ${step}`);
				assert.deepEqual(ledger.stats(), rebuilt.stats());
			}
		}
		ledger.apply({ reset: false, replaced: [], appended: [], removed: [...model.keys()] });
		assert.deepEqual(ledger.stats(), { files: 0, countedMessages: 0, buckets: 0 });
		const empty = ledger.snapshot(NOW);
		assert.equal(empty.allTime.totals.cost, 0);
		assert.equal(empty.allTime.providers.size, 0);
		assert.equal(empty.hourly.size, 0);
		assert.deepEqual(empty.allTime.insights.insights, []);
	}
});

test("insightDays: per-day insight inputs add up to the all-time totals", () => {
	const ledger = new UsageLedger();
	const r = rng(11);
	const files = [
		{ path: "/a", kind: "pi", sessionId: "a", project: "proj-a", counted: counted(r, 40, NOW.getTime() - 5 * DAY, DAY) },
		{ path: "/b", kind: "pi", sessionId: "b", project: "proj-b", counted: counted(r, 25, NOW.getTime() - 2 * DAY, DAY) },
	];
	ledger.apply({ reset: true, replaced: files, appended: [], removed: [] });
	const snap = ledger.snapshot(NOW);
	const d = snap.insightDays;
	assert.ok(d && d.raw.size > 0);
	let assistant = 0, aux = 0, proj = 0, sess = 0;
	for (const v of d.raw.values()) { assistant += v[0]; aux += v[1]; }
	for (const m of d.projects.values()) for (const c of m.values()) proj += c;
	for (const m of d.sessions.values()) for (const c of m.values()) sess += c;
	// dated usage only (undated messages count toward all-time but have no day)
	let total = 0;
	for (const h of snap.hourly.values()) for (const c of h.values()) total += c.cost;
	const near = (x, y) => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(y));
	assert.ok(near(assistant + aux, total), `${assistant + aux} vs ${total}`);
	assert.ok(near(proj, total) && near(sess, total));
	assert.deepEqual(new Set([...d.projects.values()].flatMap((m) => [...m.keys()])), new Set(["proj-a", "proj-b"]));
});

test("snapshot returns fresh objects", () => {
	const ledger = new UsageLedger();
	ledger.apply({ reset: true, replaced: [{ path: "/a", kind: "pi", sessionId: "a", project: "p", counted: counted(rng(5), 30, NOW.getTime() - DAY, DAY) }], appended: [], removed: [] });
	const a = ledger.snapshot(NOW);
	const cost = a.allTime.totals.cost;
	a.allTime.totals.cost = -1;
	a.allTime.providers.clear();
	a.hourly.clear();
	const b = ledger.snapshot(NOW);
	assert.equal(b.allTime.totals.cost, cost);
	assert.ok(b.allTime.providers.size > 0 && b.hourly.size > 0);
});

// ---------------------------------------------------------------- perf (reported)

/** A session-shaped file: one or two models, messages clustered in time (5–100 s apart). */
function sessionCounted(r, n, start) {
	const pair = PAIRS[Math.floor(r() * 4)];
	const out = [];
	let ts = start;
	const level = ["", "low", "high"][Math.floor(r() * 3)];
	for (let i = 0; i < n; i++) {
		ts += 5000 + r() * 95_000;
		const input = Math.floor(r() * 3000);
		const cacheRead = Math.floor(r() * 150_000);
		const cacheWrite = Math.floor(r() * 5000);
		const output = Math.floor(r() * 2000);
		out.push({
			msg: { provider: pair[0], model: pair[1], thinkingLevel: level, source: "assistant", sourceId: "", timestamp: Math.floor(ts), afterCompaction: false, cost: (input * 5 + output * 25 + cacheRead * 0.5 + cacheWrite * 6.25) / 1e6, input, output, cacheRead, cacheWrite, reasoning: Math.floor(r() * 400), cacheWrite1h: 0 },
			meta: { gapMs: 1000, prevCtx: 1000, modelSwitched: false, isSessionStart: i === 0 },
			miss: r() < 0.03 ? "ttl" : null,
		});
	}
	return out;
}

test("perf: snapshot and append latency with a large ledger", () => {
	const total = Number(process.env.LEDGER_PERF_MESSAGES ?? 200_000);
	const r = rng(77);
	const ledger = new UsageLedger();
	const perFile = 400;
	const t0 = NOW.getTime() - 400 * DAY;
	const heap = () => {
		globalThis.gc?.();
		return process.memoryUsage().heapUsed;
	};
	const h0 = heap();
	const tApply = performance.now();
	for (let i = 0, n = 0; n < total; i++, n += perFile) {
		const c = sessionCounted(r, perFile, t0 + r() * 400 * DAY);
		ledger.apply({ reset: false, replaced: [{ path: `/p/${i}.jsonl`, kind: "pi", sessionId: `s${i}`, project: `~/proj${i % 40}`, counted: c }], appended: [], removed: [] });
	}
	const applyMs = performance.now() - tApply;
	const h1 = heap();
	const times = [];
	for (let i = 0; i < 7; i++) {
		const t = performance.now();
		ledger.snapshot(NOW);
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	const appendTimes = [];
	for (let i = 0; i < 50; i++) {
		const add = sessionCounted(r, 5, NOW.getTime() - HOUR);
		const t = performance.now();
		ledger.apply({ reset: false, replaced: [], appended: [{ path: "/p/3.jsonl", counted: add }], removed: [] });
		appendTimes.push(performance.now() - t);
	}
	appendTimes.sort((a, b) => a - b);
	const stats = ledger.stats();
	console.log(JSON.stringify({ perf: { counted: stats.countedMessages, files: stats.files, buckets: stats.buckets, applyMs: Math.round(applyMs), snapshotMsMedian: +times[3].toFixed(1), snapshotMsMax: +times[6].toFixed(1), append5MsMedian: +appendTimes[25].toFixed(3), heapMB: +((h1 - h0) / 1e6).toFixed(1) } }));
	assert.ok(times[3] < 150, `snapshot median ${times[3]}ms`);
	assert.ok(appendTimes[25] < 5, `append median ${appendTimes[25]}ms`);
});
