import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectUsageData, emptyHourlyCell, makeHourlyKey } from "../usage-extension/data.ts";
import {
	ROLLUP_FIELDS,
	buildUsageRollup,
	lazyRollup,
	loadingSurface,
	usageLoadingPayload,
} from "../usage-extension/native.ts";

const NOW = new Date(2026, 6, 15, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "usage-native-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionsDir = join(root, "sessions", "proj");
	mkdirSync(sessionsDir, { recursive: true });
	return { root, sessionsDir: join(root, "sessions"), projDir: sessionsDir, cachePath: join(root, "cache.json") };
}

function assistantLine(ts, { provider = "anthropic", model = "claude-fable-5", cost = 1, input = 100, output = 50, cacheRead = 0, cacheWrite = 0 } = {}) {
	return JSON.stringify({
		type: "message",
		id: `m${ts}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			provider,
			model,
			usage: { input, output, cacheRead, cacheWrite, reasoning: 0, cost: { total: cost } },
			timestamp: ts,
		},
	});
}

const thinkingLine = (ts, level) =>
	JSON.stringify({ type: "thinking_level_change", id: `t${ts}`, timestamp: new Date(ts).toISOString(), thinkingLevel: level });
const sessionLine = (id, ts) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: "/tmp" });

function cell(over = {}) {
	return { ...emptyHourlyCell(), ...over };
}

function fakeData(hourly, nowMs = NOW.getTime()) {
	return { hourly, bounds: { todayMs: 0, weekStartMs: 0, lastWeekStartMs: 0, last30DaysStartMs: 0, nowMs } };
}

const col = (name) => 2 + ROLLUP_FIELDS.indexOf(name);

async function realData(t) {
	const f = fixture(t);
	const t1 = new Date(2026, 6, 13, 9, 0, 0).getTime();
	const t2 = new Date(2026, 6, 13, 9, 30, 0).getTime();
	const t3 = new Date(2026, 6, 15, 9, 0, 0).getTime();
	writeFileSync(
		join(f.projDir, "a.jsonl"),
		[
			sessionLine("s1", t1),
			thinkingLine(t1 - 1000, "high"),
			assistantLine(t1, { cost: 2, input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 }),
			thinkingLine(t2 - 1000, "low"),
			assistantLine(t2, { cost: 3, input: 40, output: 10 }),
			assistantLine(t3, { provider: "openai", model: "gpt-5.6-sol", cost: 4, input: 70, output: 30 }),
		].join("\n") + "\n"
	);
	const data = await collectUsageData({ sessionsDir: f.sessionsDir, cachePath: f.cachePath, now: NOW });
	assert.ok(data);
	return data;
}

test("rollup has the agreed wire shape and contiguous local days ending today", async (t) => {
	const data = await realData(t);
	const p = buildUsageRollup(data);
	assert.equal(p.kind, "pi-hud/usage");
	assert.equal(p.v, 1);
	assert.deepEqual(p.rollup.fields, [
		"cost", "tokens", "msgs", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h",
		"cIn", "cOut", "cCR", "cCW", "cUn", "mTtl", "mSw", "mPre", "mTtlC", "saved", "billed", "mSwC", "mPreC",
	]);
	assert.deepEqual(p.rollup.days, ["2026-07-13", "2026-07-14", "2026-07-15"]);
	assert.equal(p.rollup.generatedAt, NOW.toISOString());
	for (const row of p.rollup.rows) assert.equal(row.length, 2 + p.rollup.fields.length);
	assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test("per-day sums equal hourly totals and thinking levels are merged", async (t) => {
	const data = await realData(t);
	const { rollup } = buildUsageRollup(data);
	// anthropic on the 13th: two thinking levels merge into one row.
	const anth = rollup.keys.findIndex(([p]) => p === "anthropic");
	const rows = rollup.rows.filter((r) => r[1] === anth);
	assert.equal(rows.length, 1);
	assert.equal(rows[0][0], 0);
	assert.equal(rows[0][col("msgs")], 2);
	assert.equal(rows[0][col("cost")], 5);
	assert.equal(rows[0][col("tokens")], 100 + 50 + 200 + 40 + 10);

	let cost = 0, tokens = 0, msgs = 0;
	for (const bucket of data.hourly.values()) {
		for (const c of bucket.values()) {
			cost += c.estCost;
			tokens += c.input + c.output + c.cacheWrite;
			msgs += c.messages;
		}
	}
	const sum = (name) => rollup.rows.reduce((a, r) => a + r[col(name)], 0);
	assert.ok(Math.abs(sum("cost") - cost) < 1e-6);
	assert.equal(sum("tokens"), tokens);
	assert.equal(sum("msgs"), msgs);
	assert.equal(msgs, 3);
});

test("reporting excludes providers without cache tokens; saved positive with a known rate", () => {
	const h = 3600_000;
	const base = new Date(2026, 6, 14, 10, 0, 0).getTime();
	const hourly = new Map([
		[
			base,
			new Map([
				[
					makeHourlyKey("anthropic", "m1", "high"),
					cell({ messages: 2, cost: 1, estCost: 1, input: 1000, costInput: 0.003, cacheRead: 10000, costCacheRead: 0.003, cacheWrite: 1000, costCacheWrite: 0.00375 }),
				],
				[makeHourlyKey("zai", "glm", ""), cell({ messages: 1, cost: 0.1, estCost: 0.1, input: 100, costInput: 0.1 })],
			]),
		],
		[base + h, new Map([[makeHourlyKey("anthropic", "m1", "low"), cell({ messages: 1, input: 1000, costInput: 0.003, estCost: 0.003, cost: 0.003 })]])],
	]);
	const { rollup } = buildUsageRollup(fakeData(hourly));
	assert.deepEqual(rollup.reporting, ["anthropic"]);
	assert.deepEqual(rollup.days, ["2026-07-14", "2026-07-15"]);
	const anth = rollup.keys.findIndex(([p]) => p === "anthropic");
	const row = rollup.rows.find((r) => r[1] === anth);
	// rate = 0.006/2000 tokens = 3e-6 → read saved 0.03-0.003, write premium 0.00375-0.003
	assert.ok(row[col("saved")] > 0);
	assert.ok(Math.abs(row[col("saved")] - ((10000 * 3e-6 - 0.003) - (0.00375 - 1000 * 3e-6))) < 1e-6);
	const zai = rollup.keys.findIndex(([p]) => p === "zai");
	assert.equal(rollup.rows.find((r) => r[1] === zai)[col("saved")], 0);
});

test("mock provider is skipped and all-zero rows dropped", () => {
	const base = new Date(2026, 6, 15, 8, 0, 0).getTime();
	const hourly = new Map([
		[
			base,
			new Map([
				[makeHourlyKey("mock", "x", ""), cell({ messages: 5, cost: 9, estCost: 9 })],
				[makeHourlyKey("a", "b", ""), cell()],
			]),
		],
	]);
	const { rollup } = buildUsageRollup(fakeData(hourly));
	assert.ok(!rollup.keys.some(([p]) => p === "mock"));
	assert.equal(rollup.rows.length, 0);
	assert.deepEqual(rollup.days, ["2026-07-15"]);
});

test("one year of synthetic history stays under 300 KB", () => {
	const hourly = new Map();
	const start = NOW.getTime() - 365 * DAY;
	const models = [];
	for (let p = 0; p < 3; p++) for (let m = 0; m < 3; m++) models.push([`prov${p}`, `model-${m}`]);
	for (let d = 0; d < 365; d++) {
		for (let h = 9; h < 18; h++) {
			const ms = Math.floor((start + d * DAY) / 3600_000) * 3600_000 + h * 3600_000;
			const bucket = new Map();
			for (let i = 0; i < 6; i++) {
				const [p, m] = models[(d * 3 + (i >> 1)) % models.length];
				const x = (d * 31 + h * 7 + i) % 97 + 1;
				bucket.set(makeHourlyKey(p, m, i % 2 ? "high" : "low"), cell({
					messages: x, cost: x * 0.0123457, estCost: x * 0.0123457, input: x * 1234, output: x * 321,
					cacheRead: x * 54321, cacheWrite: x * 2111, cacheWrite1h: x * 11, costInput: x * 0.0031, costOutput: x * 0.0041,
					costCacheRead: x * 0.0011, costCacheWrite: x * 0.0021, missTtl: x % 3, missTtlCost: x * 0.001,
				}));
			}
			hourly.set(ms, bucket);
		}
	}
	const p = buildUsageRollup(fakeData(hourly));
	const size = Buffer.byteLength(JSON.stringify(p));
	assert.ok(size < 300 * 1024, `payload ${size} bytes`);
	assert.ok(p.rollup.days.length >= 365);
});

test("loading payload shape and memoization helpers", () => {
	assert.deepEqual(usageLoadingPayload("Loading Usage..."), { kind: "pi-hud/usage", v: 1, loading: { message: "Loading Usage..." } });
	const s = loadingSurface("Loading Usage...");
	const first = s.get();
	s.set("Loading Usage...");
	assert.equal(s.get(), first);
	s.set("Building…");
	assert.notEqual(s.get(), first);
	assert.equal(s.get().loading.message, "Building…");
	const lazy = lazyRollup(fakeData(new Map()));
	assert.equal(lazy(), lazy());
});

test("index.ts wires the flow's surface onto the /usage component", () => {
	// index.ts uses extensionless imports (pi's loader) and pi packages, so node's
	// test runner cannot import it; assert the wiring statically.
	const src = readFileSync(new URL("../usage-extension/index.ts", import.meta.url), "utf8");
	assert.match(src, /this\.surfaceData = \(\) => this\.flow\.surface\(\)/);
	assert.match(src, /createUsageFlow\(/);
	assert.doesNotMatch(src, /loader\.setMessage\(`/);
});
