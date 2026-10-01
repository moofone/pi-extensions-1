// Resumable parsing: parsing a file in any split into chunks equals one full parse.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSessionBuffer } from "../usage-extension/data.ts";
import { applyParseDelta, parseFile, parseFileDelta } from "../usage-extension/index/parse.ts";
import {
	collectJsonlFiles,
	collectNamedFiles,
	fallbackSessionId,
	parseClaudeCodeBuffer,
	parseUsageFileBuffer,
	parseUsageSourcesSetting,
} from "../usage-extension/sources.ts";
import { appendTurns, makeHistory } from "./usage-index-support.mjs";

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

function tmp(t, prefix = "usage-parse-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function discovered(path, kind) {
	const st = statSync(path);
	return { path, kind, size: st.size, mtimeMs: st.mtimeMs };
}

async function legacyParse(kind, path) {
	const parsed = await parseUsageFileBuffer(kind, readFileSync(path), undefined, parseSessionBuffer);
	parsed.sessionId = fallbackSessionId(kind, path, parsed.sessionId);
	return parsed;
}

/** Cut points (byte offsets, mid-line allowed): 1-10 random cuts, sorted. */
function randomCuts(length, r) {
	const n = 1 + Math.floor(r() * 10);
	const cuts = [];
	for (let i = 0; i < n; i++) cuts.push(Math.floor(r() * length));
	return cuts.sort((a, b) => a - b);
}

/** Write growing prefixes of `buffer` to `work` and parse after each; returns the final record. */
async function parseInChunks(kind, work, buffer, cuts) {
	let previous;
	for (const cut of [...cuts, buffer.length]) {
		writeFileSync(work, buffer.subarray(0, cut));
		const outcome = await parseFile(discovered(work, kind), previous);
		assert.ok(outcome, "parse outcome");
		previous = outcome.record;
	}
	return previous;
}

/** Chunked == full (parsed + resume state) and == legacy full parse of the same bytes. */
async function assertChunkInvariant(t, kind, source, label, seeds = [1, 2, 3], dir = tmp(t)) {
	const buffer = readFileSync(source);
	const work = join(dir, `work-${kind}.jsonl`);
	writeFileSync(work, buffer);
	const full = (await parseFile(discovered(work, kind), undefined)).record;
	assert.deepStrictEqual(full.parsed, await legacyParse(kind, work), `${label}: full parse == legacy`);
	for (const seed of seeds) {
		const cuts = randomCuts(buffer.length, rng(seed * 7919 + buffer.length));
		const chunked = await parseInChunks(kind, work, buffer, cuts);
		assert.deepStrictEqual(chunked.parsed, full.parsed, `${label}: cuts ${cuts.join(",")}`);
		assert.deepStrictEqual(chunked.resume, full.resume, `${label}: resume after cuts ${cuts.join(",")}`);
	}
}

// =============================================================================
// Synthetic pi history
// =============================================================================

test("pi: random mid-line chunking equals one full parse on makeHistory()", async (t) => {
	const dir = tmp(t);
	const files = makeHistory(join(dir, "sessions"), { seed: 11, sessions: 16 });
	let checked = 0;
	for (const file of files) {
		await assertChunkInvariant(t, "pi", file, file, [1, 2, 3, 4], dir);
		checked++;
	}
	assert.ok(checked >= 16);
});

test("pi: resume metadata (offset past last newline, head/tail hashes) and append outcome", async (t) => {
	const dir = tmp(t);
	const [file] = makeHistory(join(dir, "sessions"), { seed: 5, sessions: 1 });
	const first = await parseFile(discovered(file, "pi"), undefined);
	assert.equal(first.change.type, "full");
	const size = statSync(file).size;
	assert.equal(first.record.resume.offset, size);
	assert.equal(first.record.resume.headHash.length, 40);
	const before = first.record.parsed.messages.length;
	appendTurns(file, 4, 9);
	const second = await parseFile(discovered(file, "pi"), first.record);
	assert.equal(second.change.type, "append");
	assert.equal(second.change.messagesFrom, before);
	assert.ok(second.record.parsed.messages.length > before);
	assert.equal(second.record.parsed.messages[0], first.record.parsed.messages[0], "earlier objects are reused");
	assert.deepStrictEqual(second.record.parsed, (await parseFile(discovered(file, "pi"), undefined)).record.parsed);
	// Nothing new → "none"
	const third = await parseFile(discovered(file, "pi"), second.record);
	assert.equal(third.change.type, "none");
	// A partial line only → none, resume unchanged
	appendFileSync(file, '{"type":"message","id":"half"');
	const fourth = await parseFile(discovered(file, "pi"), third.record);
	assert.equal(fourth.change.type, "none");
	assert.deepStrictEqual(fourth.record.resume, third.record.resume);
});

test("pi: thinking level and compaction state carry across a cut", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "s.jsonl");
	const msg = (id, ts) =>
		JSON.stringify({
			type: "message",
			id,
			timestamp: new Date(ts).toISOString(),
			message: { role: "assistant", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cost: { total: 0.5 } }, timestamp: ts },
		});
	const head = [
		JSON.stringify({ type: "session", id: "sid", cwd: "/p" }),
		JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
		JSON.stringify({ type: "compaction", id: "c", timestamp: new Date(1000).toISOString(), usage: { input: 5, output: 1, cost: 0.1 } }),
	].join("\n") + "\n";
	writeFileSync(file, head);
	const first = (await parseFile(discovered(file, "pi"), undefined)).record;
	appendFileSync(file, msg("a", 2000) + "\n" + msg("b", 3000) + "\n");
	const next = await parseFile(discovered(file, "pi"), first);
	assert.equal(next.change.type, "append");
	const m = next.record.parsed.messages;
	assert.deepEqual(m.slice(-2).map((x) => [x.thinkingLevel, x.afterCompaction]), [["high", true], ["high", false]]);
});

// =============================================================================
// Hand-written extra-source fixtures
// =============================================================================

const ISO = "2026-07-15T09:00:00.000Z";
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function claudeFixture() {
	const a = (uuid, n) => ({
		type: "assistant",
		uuid,
		sessionId: "s-cc",
		cwd: "/proj",
		timestamp: ISO,
		effort: n % 2 ? "high" : "",
		message: { id: `m${n}`, role: "assistant", model: "claude-opus-5", usage: { input_tokens: n, cache_creation_input_tokens: 3, cache_read_input_tokens: 9, output_tokens: 2 } },
	});
	const rows = [{ type: "user", sessionId: "s-cc", message: { role: "user", content: "hi" } }];
	for (let i = 1; i <= 30; i++) rows.push(a(`u${i}`, i), { type: "attachment", sessionId: "s-cc" });
	return jl(...rows);
}

function codexFixture() {
	const rows = [{ timestamp: ISO, type: "session_meta", payload: { session_id: "s-cx", cwd: "/repo" } }];
	for (let i = 1; i <= 12; i++) {
		rows.push({ timestamp: ISO, type: "turn_context", payload: { turn_id: `t${i}`, model: i % 3 ? "gpt-6-astra" : "gpt-6-luna", effort: "xhigh" } });
		for (let j = 0; j < 2; j++) {
			rows.push({ timestamp: ISO, type: "token_usage_record", payload: { turn_id: `t${i}`, response_id: `r${i}-${j}`, usage: { input_tokens: 50 + i, cached_input_tokens: 10, output_tokens: 4 } } });
		}
	}
	return jl(...rows);
}

function grokFixture() {
	const rows = [];
	for (let i = 1; i <= 25; i++) {
		rows.push({ timestamp: 1_784_000_000 + i, params: { sessionId: "s-gk", update: { sessionUpdate: "agent_message_chunk" } } });
		rows.push({
			timestamp: 1_784_000_000 + i,
			params: { sessionId: "s-gk", update: { sessionUpdate: "turn_completed", prompt_id: `p${i}`, usage: { modelUsage: { "grok-4.6-build": { inputTokens: 100 + i, outputTokens: 9, cachedReadTokens: 10, costUsdTicks: 5_000_000 } } } } },
		});
	}
	return jl(...rows);
}

for (const [kind, build] of [
	["claude-code", claudeFixture],
	["codex-cli", codexFixture],
	["grok-build", grokFixture],
]) {
	test(`${kind}: random mid-line chunking equals one full parse (hand-written fixture)`, async (t) => {
		const dir = tmp(t);
		const source = join(dir, "src.jsonl");
		writeFileSync(source, build());
		await assertChunkInvariant(t, kind, source, kind, Array.from({ length: 40 }, (_, i) => i + 1), dir);
		// Same without a trailing newline (last record complete but unterminated).
		writeFileSync(source, build().replace(/\n$/, ""));
		await assertChunkInvariant(t, kind, source, `${kind} unterminated`, Array.from({ length: 20 }, (_, i) => i + 100), dir);
	});
}

test("claude-code: learning the sessionId in an appended chunk forces a full parse", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "cc.jsonl");
	writeFileSync(file, jl({ type: "user", message: { role: "user", content: "x" } }));
	const first = (await parseFile(discovered(file, "claude-code"), undefined)).record;
	assert.equal(first.parsed.sessionId, `ext:claude-code:${file}`);
	appendFileSync(file, claudeFixture());
	const next = await parseFile(discovered(file, "claude-code"), first);
	assert.equal(next.change.type, "full");
	assert.equal(next.record.parsed.sessionId, "s-cc");
	// Now known: further appends stay incremental.
	appendFileSync(file, jl(JSON.parse(claudeFixture().split("\n")[1])));
	const again = await parseFile(discovered(file, "claude-code"), next.record);
	assert.equal(again.change.type, "append");
	assert.deepStrictEqual(again.record.parsed, (await parseFile(discovered(file, "claude-code"), undefined)).record.parsed);
});

test("codex-cli: a later turn_context that re-attributes earlier records forces a full parse", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "cx.jsonl");
	const usage = (turn, id) => ({ timestamp: ISO, type: "token_usage_record", payload: { turn_id: turn, response_id: id, usage: { input_tokens: 8, output_tokens: 1 } } });
	const ctx = (turn, model) => ({ timestamp: ISO, type: "turn_context", payload: { turn_id: turn, model, effort: "medium" } });
	writeFileSync(file, jl({ timestamp: ISO, type: "session_meta", payload: { session_id: "s-cx" } }, usage("late", "r1"), usage("", "r2")));
	const first = (await parseFile(discovered(file, "codex-cli"), undefined)).record;
	assert.equal(first.parsed.messages[0].model, "unknown");
	appendFileSync(file, jl(ctx("late", "gpt-5.6-luna")));
	const next = await parseFile(discovered(file, "codex-cli"), first);
	assert.equal(next.change.type, "full");
	assert.deepEqual(next.record.parsed.messages.map((m) => m.model), ["gpt-5.6-luna", "gpt-5.6-luna"]);
	assert.deepStrictEqual(next.record.parsed, (await parseFile(discovered(file, "codex-cli"), undefined)).record.parsed);

	// Redefining an existing turn differently also reparses; a brand-new turn after resolved records appends.
	appendFileSync(file, jl(ctx("late", "gpt-6-astra")));
	const redefined = await parseFile(discovered(file, "codex-cli"), next.record);
	assert.equal(redefined.change.type, "full");
	// `fallbackUsed` is still true here (record r2 has no turn id), so any context reparses; use a clean file.
	const clean = join(dir, "cx2.jsonl");
	writeFileSync(clean, jl({ timestamp: ISO, type: "session_meta", payload: { session_id: "s" } }, ctx("a", "gpt-6-astra"), usage("a", "r1")));
	const c1 = (await parseFile(discovered(clean, "codex-cli"), undefined)).record;
	appendFileSync(clean, jl(ctx("b", "gpt-6-luna"), usage("b", "r2")));
	const c2 = await parseFile(discovered(clean, "codex-cli"), c1);
	assert.equal(c2.change.type, "append");
	assert.deepEqual(c2.record.parsed.messages.map((m) => m.model), ["gpt-6-astra", "gpt-6-luna"]);
	assert.deepStrictEqual(c2.record.parsed, (await parseFile(discovered(clean, "codex-cli"), undefined)).record.parsed);
});

test("opencode-go: single JSON documents are always parsed whole, resume null", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "msg_1.json");
	const doc = { id: "msg_1", sessionID: "ses_1", role: "assistant", providerID: "opencode-go", modelID: "glm-5.3", cost: 0.25, tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, time: { completed: 1_784_000_000_000 }, path: { cwd: "/w" } };
	writeFileSync(file, JSON.stringify(doc));
	const first = await parseFile(discovered(file, "opencode-go"), undefined);
	assert.equal(first.record.resume, null);
	assert.equal(first.record.parsed.sessionId, "ses_1");
	assert.equal(first.record.parsed.messages.length, 1);
	writeFileSync(file, JSON.stringify({ ...doc, cost: 0.5 }));
	const second = await parseFile(discovered(file, "opencode-go"), first.record);
	assert.equal(second.change.type, "full");
	assert.equal(second.record.parsed.messages[0].cost, 0.5);
	// Missing file → null.
	assert.equal(await parseFile({ path: join(dir, "gone.json"), kind: "opencode-go", size: 1, mtimeMs: 1 }, undefined), null);
});

// =============================================================================
// Rewrite / truncation / head change → full parse
// =============================================================================

test("rewrite, truncation, head/tail change and missing files fall back to a full parse", async (t) => {
	const dir = tmp(t);
	const [file] = makeHistory(join(dir, "sessions"), { seed: 21, sessions: 1 });
	const original = readFileSync(file);
	const base = (await parseFile(discovered(file, "pi"), undefined)).record;
	const expectFull = async (label) => {
		const outcome = await parseFile(discovered(file, "pi"), base);
		assert.equal(outcome.change.type, "full", label);
		assert.deepStrictEqual(outcome.record.parsed, (await parseFile(discovered(file, "pi"), undefined)).record.parsed, label);
	};

	// Truncated below the resume offset.
	writeFileSync(file, original.subarray(0, original.length - 50));
	await expectFull("truncated");

	// Same length, different head byte.
	const headChanged = Buffer.from(original);
	headChanged[10] = headChanged[10] === 0x78 ? 0x79 : 0x78;
	writeFileSync(file, Buffer.concat([headChanged, Buffer.from("\n")]));
	await expectFull("head changed");

	// Head intact, tail (last 256 bytes before the offset) changed, then grown.
	const tailChanged = Buffer.from(original);
	tailChanged[tailChanged.length - 5] = tailChanged[tailChanged.length - 5] === 0x78 ? 0x79 : 0x78;
	writeFileSync(file, Buffer.concat([tailChanged, Buffer.from("\n")]));
	await expectFull("tail changed");

	// Rewritten to a different, longer history.
	writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify({ type: "session", id: "other", cwd: "/o" }) + "\n"), original, original]));
	await expectFull("rewritten");

	// Vanished file.
	rmSync(file);
	assert.equal(await parseFile({ path: file, kind: "pi", size: 0, mtimeMs: 0 }, base), null);
	assert.equal(await parseFileDelta({ path: file, kind: "pi", size: 0, mtimeMs: 0 }, base.resume), null);

	// Bogus resume state → full.
	writeFileSync(file, original);
	const bogus = await parseFileDelta(discovered(file, "pi"), { offset: -1, headHash: "x", tailHash: "y", state: {} });
	assert.equal(bogus.mode, "full");
});

test("short files (resume offset < 256 / < 512) keep correct head and tail hashes across appends", async (t) => {
	const dir = tmp(t);
	const file = join(dir, "short.jsonl");
	const line = (n) => JSON.stringify({ type: "message", id: `m${n}`, timestamp: ISO, message: { role: "assistant", provider: "p", model: "m", usage: { input: n, output: 1, cost: { total: 1 } }, timestamp: 1_784_000_000_000 + n } });
	let previous;
	writeFileSync(file, "");
	for (let n = 1; n <= 12; n++) {
		appendFileSync(file, line(n) + "\n");
		const outcome = await parseFile(discovered(file, "pi"), previous);
		if (previous) assert.equal(outcome.change.type, "append", `step ${n}`);
		previous = outcome.record;
		const fresh = (await parseFile(discovered(file, "pi"), undefined)).record;
		assert.deepStrictEqual(previous.resume, fresh.resume, `resume at step ${n}`);
		assert.deepStrictEqual(previous.parsed, fresh.parsed);
	}
});

test("applyParseDelta: none keeps the previous parsed object; full replaces", async (t) => {
	const dir = tmp(t);
	const [file] = makeHistory(join(dir, "sessions"), { seed: 3, sessions: 1 });
	const d = discovered(file, "pi");
	const first = (await parseFile(d, undefined)).record;
	const none = await parseFileDelta(d, first.resume);
	assert.equal(none.mode, "none");
	const applied = applyParseDelta(d, first, none);
	assert.equal(applied.record.parsed, first.parsed);
	assert.equal(applied.change.type, "none");
});

// =============================================================================
// Real history (copies in /tmp; skipped silently when absent)
// =============================================================================

async function largest(files, n) {
	const sized = [];
	for (const path of files) {
		try {
			sized.push([statSync(path).size, path]);
		} catch {
			/* vanished */
		}
	}
	return sized.sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => x[1]);
}

const AGENT_DIR = join(homedir(), ".pi", "agent");

test("real pi sessions: 30 largest files chunk-parse identically to a full parse", async (t) => {
	const sessions = join(AGENT_DIR, "sessions");
	if (!existsSync(sessions)) return t.skip("no ~/.pi/agent/sessions");
	const dir = tmp(t);
	const picks = await largest(await collectJsonlFiles(sessions), 30);
	const started = Date.now();
	let bytes = 0;
	for (const [i, source] of picks.entries()) {
		const copy = join(dir, `real-${i}.jsonl`);
		copyFileSync(source, copy);
		bytes += statSync(copy).size;
		await assertChunkInvariant(t, "pi", copy, `real pi #${i}`, [1, 2], dir);
		rmSync(copy);
	}
	console.log(`# real pi: ${picks.length} files, ${(bytes / 1e6).toFixed(0)} MB, ${Date.now() - started} ms (full+legacy+2 chunked runs each)`);
});

test("real extra-source files: up to 10 per enabled source chunk-parse identically to a full parse", async (t) => {
	let settings = "{}";
	try {
		settings = readFileSync(join(AGENT_DIR, "settings.json"), "utf8");
	} catch {
		return t.skip("no settings.json");
	}
	const sources = parseUsageSourcesSetting(settings);
	const dir = tmp(t);
	const lists = [
		["claude-code", sources.claudeCode, collectJsonlFiles],
		["codex-cli", sources.codexCli, collectJsonlFiles],
		["grok-build", sources.grokBuild, (root, s) => collectNamedFiles(root, "updates.jsonl", s)],
	];
	let total = 0;
	for (const [kind, cfg, list] of lists) {
		if (!cfg.enabled) continue;
		const files = [];
		for (const root of cfg.roots) {
			try {
				files.push(...(await list(root)));
			} catch {
				/* root missing */
			}
		}
		for (const [i, source] of (await largest(files, 10)).entries()) {
			const copy = join(dir, `${kind}-${i}.jsonl`);
			copyFileSync(source, copy);
			await assertChunkInvariant(t, kind, copy, `${kind} #${i}`, [1, 2, 3], dir);
			rmSync(copy);
			total++;
		}
	}
	console.log(`# real extra-source files checked: ${total}`);
});

// =============================================================================
// Large file: an append costs ∝ appended bytes
// =============================================================================

test("large real file + 5 appended turns: parseFileDelta reads ≪ the file and takes < 20 ms", async (t) => {
	const sessions = join(AGENT_DIR, "sessions");
	if (!existsSync(sessions)) return t.skip("no ~/.pi/agent/sessions");
	const [source] = await largest(await collectJsonlFiles(sessions), 1);
	if (!source) return t.skip("no session files");
	const dir = tmp(t);
	const copy = join(dir, "big.jsonl");
	copyFileSync(source, copy);
	if (readFileSync(copy).at(-1) !== 0x0a) appendFileSync(copy, "\n");
	const size = statSync(copy).size;

	// Instrument FileHandle.read to count bytes read.
	const probe = await open(copy, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const originalRead = proto.read;
	let bytesRead = 0;
	proto.read = async function (...args) {
		const result = await originalRead.apply(this, args);
		bytesRead += result.bytesRead;
		return result;
	};
	t.after(() => {
		proto.read = originalRead;
	});

	const first = (await parseFile(discovered(copy, "pi"), undefined)).record;
	assert.ok(bytesRead >= size * 0.99, "full parse reads the whole file");
	let previous = first;
	const timings = [];
	for (let round = 0; round < 5; round++) {
		const before = statSync(copy).size;
		appendTurns(copy, 5, 500 + round, Date.now() - 600_000);
		const appended = statSync(copy).size - before;
		bytesRead = 0;
		const started = performance.now();
		const outcome = await parseFile(discovered(copy, "pi"), previous);
		const ms = performance.now() - started;
		timings.push(ms);
		assert.equal(outcome.change.type, "append");
		assert.ok(bytesRead <= appended + 600, `read ${bytesRead} bytes for ${appended} appended (file ${size})`);
		assert.ok(bytesRead < size / 100, "reads ≪ the file");
		previous = outcome.record;
	}
	assert.deepStrictEqual(previous.parsed, (await parseFile(discovered(copy, "pi"), undefined)).record.parsed);
	const sorted = [...timings].sort((a, b) => a - b);
	console.log(`# large-file append: file ${(size / 1e6).toFixed(0)} MB, parseFile ms per append ${timings.map((x) => x.toFixed(2)).join(", ")}`);
	assert.ok(sorted[Math.floor(sorted.length / 2)] < 20, `median append parse ${sorted[2]} ms < 20 ms`);
});

test("claude-code buffer wrapper still returns full-parse behaviour on unterminated input", async () => {
	const parsed = await parseClaudeCodeBuffer(Buffer.from(claudeFixture().trimEnd(), "utf8"));
	assert.equal(parsed.messages.length, 30);
	assert.equal(parsed.sessionId, "s-cc");
});
