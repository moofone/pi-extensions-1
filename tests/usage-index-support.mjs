/**
 * Shared test support for the usage index (scaffold; lanes may ADD helpers in their own files, do not edit).
 *
 * - makeHistory(dir, { seed, sessions }) writes a synthetic Pi session history: several providers/models,
 *   thinking-level changes, cache reads/writes (incl. 1h), idle gaps (TTL misses), model switches,
 *   compactions, branch summaries, Pi 0.81 tool-result usage, and branched copies (duplicated history in a
 *   second file) — everything the legacy dedupe/insight rules care about.
 * - appendTurns(file, n, seed) appends assistant turns to an existing session file (append-only growth).
 * - normalizeUsageData(data) → plain JSON (Maps/Sets sorted) for deep comparison.
 * - assertUsageDataEqual(actual, expected, label) deep-compares with 1e-9 relative float tolerance.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

const MODELS = [
	["anthropic", "claude-opus-5-5"],
	["anthropic", "claude-sonnet-5-5"],
	["openai-codex", "gpt-6-luna"],
	["xai", "grok-4.7"],
	["zcode-re", "GLM-5.3"],
	["devin", "swe-2"],
	["cursor", "auto"],
];

function usage(r, cached) {
	const input = Math.floor(r() * 4000) + 1;
	const output = Math.floor(r() * 3000) + 10;
	const cacheRead = cached ? Math.floor(20000 + r() * 150000) : 0;
	const cacheWrite = Math.floor(r() * 9000);
	const cost = { input: input * 5e-6, output: output * 25e-6, cacheRead: cacheRead * 5e-7, cacheWrite: cacheWrite * 6.25e-6 };
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return { input, output, cacheRead, cacheWrite, cacheWrite1h: r() < 0.5 ? cacheWrite : 0, reasoning: Math.floor(r() * 500), totalTokens: input + output + cacheRead + cacheWrite, cost };
}

function line(obj) {
	return JSON.stringify(obj) + "\n";
}

export function sessionLines({ id, cwd, start, turns, seed }) {
	const r = rng(seed);
	let ts = start;
	let out = line({ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd });
	let [provider, model] = MODELS[Math.floor(r() * MODELS.length)];
	for (let i = 0; i < turns; i++) {
		ts += r() < 0.15 ? 6 * 60_000 + Math.floor(r() * 3_600_000) : Math.floor(5_000 + r() * 90_000);
		if (r() < 0.1) out += line({ type: "thinking_level_change", id: `t${i}`, timestamp: new Date(ts).toISOString(), thinkingLevel: ["low", "medium", "high", "xhigh"][Math.floor(r() * 4)] });
		if (r() < 0.08) [provider, model] = MODELS[Math.floor(r() * MODELS.length)];
		if (r() < 0.04) out += line({ type: "compaction", id: `c${i}`, timestamp: new Date(ts).toISOString(), summary: "s", firstKeptEntryId: "k", tokensBefore: 1000, usage: usage(r, false) });
		if (r() < 0.03) out += line({ type: "branch_summary", id: `b${i}`, timestamp: new Date(ts).toISOString(), fromId: "x", summary: "s", usage: usage(r, false) });
		const cached = provider !== "cursor" && r() > 0.12;
		const u = usage(r, cached);
		if (provider === "cursor") Object.assign(u, { cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
		out += line({ type: "message", id: `m${i}`, parentId: null, timestamp: new Date(ts).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x" }], provider, model, usage: u, timestamp: ts } });
		if (r() < 0.06) {
			const tu = usage(r, false);
			out += line({ type: "message", id: `tool${i}`, parentId: null, timestamp: new Date(ts + 500).toISOString(), message: { role: "toolResult", toolCallId: `call${i}`, toolName: "nested_llm", content: [{ type: "text", text: "done" }], usage: tu, isError: false, timestamp: ts + 500 } });
		}
	}
	return { text: out, endTs: ts };
}

/** Writes `sessions` session files (+ branched copies) under `dir`; returns their paths. */
export function makeHistory(dir, { seed = 1, sessions = 12, now = Date.now() } = {}) {
	const r = rng(seed);
	const paths = [];
	for (let s = 0; s < sessions; s++) {
		const project = join(dir, `--Users-me-Dev-git-proj${s % 4}--`);
		mkdirSync(project, { recursive: true });
		const start = now - Math.floor(r() * 45) * 86_400_000 - Math.floor(r() * 86_400_000);
		const { text } = sessionLines({ id: `s${seed}-${s}`, cwd: `/Users/me/Dev/git/proj${s % 4}`, start, turns: 5 + Math.floor(r() * 60), seed: seed * 1000 + s });
		const file = join(project, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_s${s}.jsonl`);
		writeFileSync(file, text);
		paths.push(file);
		if (r() < 0.3) {
			// A branched copy: same session id and history prefix, then its own turns.
			const lines = text.split("\n").filter(Boolean);
			const keep = lines.slice(0, Math.max(2, Math.floor(lines.length * (0.4 + r() * 0.5))));
			const copy = file.replace(/\.jsonl$/, `-fork.jsonl`);
			const tail = sessionLines({ id: `s${seed}-${s}`, cwd: `/Users/me/Dev/git/proj${s % 4}`, start: now - 3_600_000, turns: 3, seed: seed * 7777 + s }).text.split("\n").slice(1).join("\n");
			writeFileSync(copy, keep.join("\n") + "\n" + tail);
			paths.push(copy);
		}
	}
	return paths;
}

/** Appends `n` assistant turns to a session file (keeps it a valid append-only JSONL). */
export function appendTurns(file, n, seed, startTs = Date.now() - 600_000) {
	const { text } = sessionLines({ id: "unused", cwd: "/x", start: startTs, turns: n, seed });
	appendFileSync(file, text.split("\n").slice(1).join("\n"));
}

export function normalizeUsageData(data) {
	// insightDays is ledger-only (native clients); the legacy oracle has no equivalent
	if (data && typeof data === "object" && "insightDays" in data) {
		const { insightDays: _skip, ...rest } = data;
		data = rest;
	}
	const norm = (v) => {
		if (v instanceof Map) return [...v.entries()].map(([k, x]) => [String(k), norm(x)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		if (v instanceof Set) return [...v].map(String).sort();
		if (Array.isArray(v)) return v.map(norm);
		if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
		return v;
	};
	return norm(data);
}

export function assertUsageDataEqual(actual, expected, label = "usage data") {
	const a = normalizeUsageData(actual);
	const e = normalizeUsageData(expected);
	const walk = (x, y, path) => {
		if (typeof x === "number" && typeof y === "number") {
			const ok = x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
			assert.ok(ok, `${label}: ${path}: ${x} !== ${y}`);
			return;
		}
		if (Array.isArray(x) && Array.isArray(y)) {
			assert.equal(x.length, y.length, `${label}: ${path}: length ${x.length} !== ${y.length}`);
			x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
			return;
		}
		if (x && y && typeof x === "object" && typeof y === "object") {
			assert.deepEqual(Object.keys(x), Object.keys(y), `${label}: ${path}: keys`);
			for (const k of Object.keys(x)) walk(x[k], y[k], `${path}.${k}`);
			return;
		}
		assert.deepEqual(x, y, `${label}: ${path}`);
	};
	walk(a, e, "$");
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
