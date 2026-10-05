import { createHash } from "node:crypto";

import type { WorkflowCall, WorkflowRecord, WorkflowUsage } from "./types.ts";

/**
 * Pure normalization of one parsed Pi JSONL object. Retains hashes, byte counts and scalars only: never
 * bodies, commands, paths, thoughts, images or signatures. Unknown stays absent (never zero).
 * Visible text = concatenation (no separator) of `text` blocks, or the string content.
 */

const MAX_ID = 200;
const MAX_SMALL = 64;
const MAX_ROLE = 48;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_CALLS = 64;
const MAX_COMMAND_CHARS = 100_000;
const MAX_EXIT = 1_000_000;
const ROLE_SCAN_CHARS = 4096;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const idOf = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 && v.length <= MAX_ID ? v : undefined;
const smallOf = (v: unknown): string | undefined => typeof v === "string" && v.length <= MAX_SMALL && /^[\w.:/@+-]+$/.test(v) ? v : undefined;
const roleOf = (v: unknown): string | undefined => typeof v === "string" && v.length <= MAX_ROLE && /^[A-Za-z][\w.-]*$/.test(v) ? v : undefined;
const count = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export function opaqueWorkflowRecord(line: number): WorkflowRecord {
	return { id: `line:${line}`, line, kind: "opaque" };
}

function opaqueFor(e: Obj, line: number): WorkflowRecord {
	const r: WorkflowRecord = { id: idOf(e.id) ?? `line:${line}`, line, kind: "opaque" };
	const parent = idOf(e.parentId);
	if (parent) r.parentId = parent;
	return r;
}

function timeOf(e: Obj, m?: Obj): number | undefined {
	const m1 = m?.timestamp;
	if (typeof m1 === "number" && Number.isFinite(m1) && m1 > 0) return m1;
	const t = e.timestamp;
	if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
	if (typeof t === "string") {
		const p = Date.parse(t);
		if (Number.isFinite(p) && p > 0) return p;
	}
	return undefined;
}

interface Content { text?: string; calls: Obj[]; huge: boolean }
function readContent(content: unknown): Content {
	if (typeof content === "string") return content.length > MAX_TEXT_CHARS ? { calls: [], huge: true } : { text: content, calls: [], huge: false };
	if (!Array.isArray(content)) return { calls: [], huge: false };
	let text: string | undefined;
	let chars = 0;
	const calls: Obj[] = [];
	for (const b of content) {
		if (!isObj(b)) continue;
		if (b.type === "text" && typeof b.text === "string") {
			chars += b.text.length;
			if (chars > MAX_TEXT_CHARS) return { calls: [], huge: true };
			text = (text ?? "") + b.text;
		} else if (b.type === "toolCall" && calls.length < MAX_CALLS) calls.push(b);
	}
	return { text, calls, huge: false };
}

function usageOf(u: unknown): WorkflowUsage | undefined {
	if (!isObj(u)) return undefined;
	const out: WorkflowUsage = {};
	const set = (k: keyof WorkflowUsage, v: number | undefined) => { if (v !== undefined) out[k] = v; };
	set("input", count(u.input));
	set("output", count(u.output));
	set("cacheRead", count(u.cacheRead));
	set("cacheWrite", count(u.cacheWrite));
	set("reasoning", count(u.reasoning ?? u.reasoningTokens));
	set("cost", count(isObj(u.cost) ? u.cost.total : u.cost));
	return Object.keys(out).length ? out : undefined;
}

// ── structured / declared roles ──
function structuredRole(e: Obj, m?: Obj): string | undefined {
	for (const o of [e, m]) {
		if (!o) continue;
		for (const k of ["agentRole", "agent_role", "agentName", "agent_name"]) {
			const r = roleOf(o[k]);
			if (r) return r;
		}
		if (isObj(o.agent)) {
			const r = roleOf(o.agent.role) ?? roleOf(o.agent.name);
			if (r) return r;
		}
	}
	return undefined;
}
/** Anchored at the very start of the stored preamble section only; no other prose declares a role. */
function anchoredRole(preamble: string): string | undefined {
	const m = /^<active_agent name="([A-Za-z][\w.-]{0,47})"\/>/.exec(preamble.slice(0, ROLE_SCAN_CHARS));
	return m ? m[1] : undefined;
}

// ── wake / delivery ──
const WAKE_RE = /(?:^|\n)[ \t]*(?:pr|pro|dot)-latch:/;
/**
 * The one supported delivery envelope: Pi's `subagent-notify` custom_message,
 *   `Background task completed: **NAME**\n\nNAME:\nREPORT\n\nOutput saved to: PATH...`
 * REPORT is sliced exactly (only the known head and the final `\n\nOutput saved to: ` trailer are removed), so
 * its own final newline is preserved. Latch wake markers have no supported delivery wrapper (unsupported).
 * Returns undefined for file-only, partial/preview, read-required, malformed or different envelopes.
 */
const NOTIFY_HEAD_RE = /^Background task completed: \*\*([A-Za-z][\w.-]{0,47})\*\*(?: \(\d+\/\d+\))?\n\n([A-Za-z][\w.-]{0,47}):\n/;
const NOTIFY_TRAILER = "\n\nOutput saved to: ";
// Exact runtime artifact footer is informational, not an assertion that a second read is required.
const STANDARD_TRAILER_RE = /^[^\n]+ \(\d+(?:\.\d+)? (?:B|KB|MB|GB|TB), \d+ lines?\)\. Read this file if needed\.(?:\n\n(?:Retention-managed async directory|Session(?: file)?): [^\n]+)*$/;
const READ_REQUIRED_RE = /\b(?:truncated|partial|preview|read (?:it|the|this|full)|see (?:the )?(?:file|full)|full (?:report|output) (?:is )?(?:in|at|saved))/i;
const PARTIAL_LINE_RE = /(?:^|\n)[ \t]*(?:\.\.\.|…)?[ \t]*\[(?:truncated|preview|partial)[^\]\n]*\][ \t]*(?:\n|$)/i;
function projectNotifyReport(text: string): { report: string; alternate?: string } | undefined {
	const head = NOTIFY_HEAD_RE.exec(text);
	if (!head || head[1] !== head[2]) return undefined;
	const end = text.lastIndexOf(NOTIFY_TRAILER);
	if (end < head[0].length - 2) return undefined;
	const report = text.slice(head[0].length, end < head[0].length ? head[0].length : end);
	const trailer = text.slice(end + NOTIFY_TRAILER.length);
	if (end < head[0].length || trailer.length === 0 || (!STANDARD_TRAILER_RE.test(trailer) && READ_REQUIRED_RE.test(trailer))) return undefined;
	if (report.trim() === "" || PARTIAL_LINE_RE.test(report)) return undefined;
	const lines = report.split("\n").filter((l) => l.trim() !== "");
	if (lines.every((l) => /^(?:output saved to:\s*)?\S*(?:\/|\\)\S*$|^output saved to:/i.test(l.trim()))) return undefined;
	// The runtime may trim its display before appending the footer. Both ends are literal source
	// boundaries, not normalized/invented text; only an exact subsequent hash+byte match can count.
	return { report, alternate: STANDARD_TRAILER_RE.test(trailer) ? text.slice(head[0].length, end + 1) : undefined };
}

// ── outer-shell analysis: quoted/substituted/heredoc bodies are masked, never inspected ──
const Q = "\u0001";
interface Stage { words: string[]; sep: string }
function shellStages(cmd: string): Stage[] {
	const stages: Stage[] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let sep = "start";
	const pending: { tag: string; strip: boolean }[] = [];
	const endWord = () => { if (inWord) { words.push(word); word = ""; inWord = false; } };
	const endStage = (next: string) => {
		endWord();
		if (words.length) { stages.push({ words, sep }); words = []; sep = next; } else if (next !== "newline") sep = next;
	};
	const n = cmd.length;
	let i = 0;
	while (i < n) {
		const c = cmd[i];
		if (c === "\\") {
			if (cmd[i + 1] === "\n") i += 2;
			else { word += cmd[i + 1] ?? ""; inWord = true; i += 2; }
		} else if (c === "'") {
			const j = cmd.indexOf("'", i + 1);
			i = j < 0 ? n : j + 1; word += Q; inWord = true;
		} else if (c === '"') {
			let j = i + 1;
			while (j < n && cmd[j] !== '"') j += cmd[j] === "\\" ? 2 : 1;
			i = j + 1; word += Q; inWord = true;
		} else if (c === "`") {
			const j = cmd.indexOf("`", i + 1);
			i = j < 0 ? n : j + 1; word += Q; inWord = true;
		} else if (c === "$" && cmd[i + 1] === "(") {
			let depth = 0;
			let j = i + 1;
			for (; j < n; j++) { if (cmd[j] === "(") depth++; else if (cmd[j] === ")" && --depth === 0) break; }
			i = j + 1; word += Q; inWord = true;
		} else if (c === "#" && !inWord) {
			while (i < n && cmd[i] !== "\n") i++;
		} else if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<" && cmd[i + 2] !== "(") {
			let j = i + 2;
			const strip = cmd[j] === "-";
			if (strip) j++;
			while (cmd[j] === " " || cmd[j] === "\t") j++;
			const quote = cmd[j] === "'" || cmd[j] === '"' ? cmd[j] : "";
			if (quote) j++;
			let tag = "";
			while (j < n && !/[\s;|&'"]/.test(cmd[j])) tag += cmd[j++];
			if (quote && cmd[j] === quote) j++;
			if (tag) pending.push({ tag, strip });
			i = j;
		} else if (c === "\n") {
			endStage("newline"); i++;
			for (const h of pending.splice(0)) {
				while (i < n) {
					let e = cmd.indexOf("\n", i);
					if (e < 0) e = n;
					let line = cmd.slice(i, e);
					i = Math.min(n, e + 1);
					if (h.strip) line = line.replace(/^\t+/, "");
					if (line === h.tag) break;
				}
			}
		} else if (c === ";") { endStage(";"); i++; }
		else if (c === "(" || c === ")") { endStage(";"); i++; }
		else if (c === "&") {
			if (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">") { word += c; inWord = true; i++; }
			else if (cmd[i + 1] === "&") { endStage("&&"); i += 2; }
			else { endStage("&"); i++; }
		} else if (c === "|") {
			if (cmd[i + 1] === "|") { endStage("||"); i += 2; } else { endStage("|"); i += cmd[i + 1] === "&" ? 2 : 1; }
		} else if (c === " " || c === "\t" || c === "\r") { endWord(); i++; }
		else { word += c; inWord = true; i++; }
	}
	endStage("end");
	return stages;
}

const PREFIXES = new Set(["time", "sudo", "env", "command", "exec", "nice", "nohup", "builtin"]);
const FILTER_STAGES = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "sed", "awk", "cut", "sort", "uniq", "wc", "tr", "jq"]);
const SCRIPT_RE = /^(?:test|tests|t|check|typecheck|type-check|lint|verify|ci|test:\S*|check:\S*|typecheck:\S*|lint:\S*)$/;
const RUNNERS = new Set(["pytest", "py.test", "vitest", "jest", "mocha", "ava", "tap", "tsc", "eslint", "ruff", "mypy", "pyright", "rspec", "phpunit", "tox", "nox", "bats", "ctest"]);
const FILTER_FLAG_RE = /^(?:-t|-k|-g|--grep|--filter|--testNamePattern|--test-name-pattern|--testPathPattern|-run|--only|--onlyFailures)(?:=|$)/;
const FORCE_FLAG_RE = /^--(?:forceExit|force-exit|exit|test-force-exit)$/;
const SHELLS = new Set(["bash", "sh", "zsh"]);
const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);
const pathy = (w: string) => w !== Q && !w.startsWith("-") && (w.includes("/") || /\.(?:m?[jt]sx?|py|rs)$/.test(w));

interface Kind { test: boolean; positionalFilter: boolean; name: string }
function unwrap(words: string[]): string[] {
	let w = words.slice();
	while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w.shift();
	for (let guard = 0; guard < 8 && w.length && PREFIXES.has(base(w[0])); guard++) {
		w.shift();
		while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]) || w[0].startsWith("-"))) w.shift();
	}
	if (w.length && base(w[0]) === "timeout") { w.shift(); while (w.length && (w[0].startsWith("-") || /^\d/.test(w[0]))) w.shift(); }
	return w;
}
function classify(words: string[]): Kind {
	const none: Kind = { test: false, positionalFilter: false, name: "" };
	const w = unwrap(words);
	if (!w.length || w[0] === Q) return none;
	let cmd = base(w[0]);
	let rest = w.slice(1);
	const nonFlag = (a: string[]) => a.find((x) => !x.startsWith("-"));
	const after = (a: string[], x?: string) => { const k = x === undefined ? -1 : a.indexOf(x); return a.slice(k + 1); };
	if (["npx", "bunx", "pnpx", "uvx"].includes(cmd)) return classify(rest.filter((x, k) => !(k === 0 && x.startsWith("-"))));
	if (cmd === "uv" && rest[0] === "run") return classify(rest.slice(1));
	if (["pnpm", "npm", "yarn", "bun"].includes(cmd)) {
		const sub = nonFlag(rest);
		if (sub === undefined) return none;
		if (["exec", "dlx", "x"].includes(sub)) return classify(after(rest, sub));
		if (sub === "run" || sub === "run-script") { const s = nonFlag(after(rest, sub)); return { ...none, test: s !== undefined && SCRIPT_RE.test(s), name: cmd }; }
		return { ...none, test: SCRIPT_RE.test(sub), name: cmd };
	}
	if ((cmd === "python" || cmd === "python3") && rest[0] === "-m") { cmd = rest[1] ?? ""; rest = rest.slice(2); if (cmd === "unittest") return { test: true, positionalFilter: false, name: cmd }; }
	if (RUNNERS.has(cmd)) return { test: true, positionalFilter: ["pytest", "py.test", "vitest", "jest", "mocha"].includes(cmd), name: cmd };
	const sub = nonFlag(rest);
	if (cmd === "cargo") return { test: sub !== undefined && ["test", "check", "clippy", "nextest", "t"].includes(sub), positionalFilter: sub === "test" || sub === "nextest", name: "cargo" };
	if (cmd === "go") return { test: sub === "test" || sub === "vet", positionalFilter: false, name: "go" };
	if (cmd === "swift" || cmd === "dotnet" || cmd === "mvn" || cmd === "gradle" || cmd === "gradlew") return { ...none, test: sub === "test" || sub === "check", name: cmd };
	if (cmd === "deno") return { ...none, test: sub === "test" || sub === "check" || sub === "lint" };
	if (cmd === "make" || cmd === "just" || cmd === "task") return { ...none, test: sub !== undefined && /^(?:test|tests|check|lint|verify|ci)$/.test(sub) };
	if (cmd === "xcodebuild") return { ...none, test: rest.includes("test") };
	if (cmd === "node") return { ...none, test: rest.includes("--test") };
	// Explicitly executed wrapper path (e.g. scripts/node.sh --test ...): flags only, bodies never inspected.
	if (SHELLS.has(cmd) && rest[0] !== undefined && rest[0] !== Q && !rest[0].startsWith("-") && pathy(rest[0]) && /\.sh$/.test(rest[0])) return classify(rest);
	if (w[0].includes("/") && /\.sh$/.test(w[0])) return { ...none, test: rest.some((x) => x === "--test" || x === "--run-tests"), name: "wrapper" };
	return none;
}
function isFiltered(words: string[], kind: Kind): boolean {
	const w = unwrap(words);
	if (w.some((x) => FILTER_FLAG_RE.test(x))) return true;
	if (!kind.positionalFilter) return false;
	if (kind.name === "cargo") {
		const k = w.findIndex((x) => x === "test" || x === "nextest");
		const tail = w.slice(k + 1);
		const stop = tail.indexOf("--");
		return (stop < 0 ? tail : tail.slice(0, stop)).some((x) => !x.startsWith("-") && x !== "run");
	}
	return w.slice(1).some(pathy);
}

function analyzeCommand(cmd: string): Pick<WorkflowCall, "test" | "filtered" | "forcedExit" | "baselineRead"> | undefined {
	if (cmd.length > MAX_COMMAND_CHARS) return undefined;
	const stages = shellStages(cmd);
	const kinds = stages.map((s) => classify(s.words));
	let test = false, filtered = false, forced = false;
	stages.forEach((s, i) => {
		if (kinds[i].test) {
			test = true;
			if (isFiltered(s.words, kinds[i])) filtered = true;
			if (unwrap(s.words).some((x) => FORCE_FLAG_RE.test(x))) forced = true;
			for (let j = i + 1; j < stages.length && stages[j].sep === "|"; j++) {
				const next = unwrap(stages[j].words);
				if (next.length && FILTER_STAGES.has(base(next[0]))) filtered = true;
			}
		}
	});
	stages.forEach((s, i) => {
		if (s.sep !== "||" || i === 0) return;
		const w = unwrap(s.words);
		const forcedTail = (w.length === 1 && (w[0] === "true" || w[0] === ":")) || (w[0] === "exit" && (w[1] === "0" || w.length === 1));
		if (!forcedTail) return;
		// the pipeline immediately before the `||`
		let j = i - 1;
		for (;;) {
			if (kinds[j].test) { forced = true; break; }
			if (j > 0 && stages[j].sep === "|") j--; else break;
		}
	});
	// Baseline read: only a literal outer `git [opts] show REV:PATH` (unquoted REV:PATH operand).
	const baseline = stages.some((s) => {
		const w = unwrap(s.words);
		if (!w.length || base(w[0]) !== "git") return false;
		let k = 1;
		while (k < w.length && w[k].startsWith("-")) k += w[k] === "-C" || w[k] === "-c" ? 2 : 1;
		return w[k] === "show" && w.slice(k + 1).some((x) => /^[^\s:\u0001-][^\s:\u0001]*:[^\s\u0001]+$/.test(x));
	});
	const out: Pick<WorkflowCall, "test" | "filtered" | "forcedExit" | "baselineRead"> = { test, baselineRead: baseline };
	if (test) { out.filtered = filtered; out.forcedExit = forced; }
	return out;
}

// ── mutations ──
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "exec", "run_command", "execute_bash", "terminal"]);
const MUTATION_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "notebookedit"]);
export function testNamedPath(p: string): boolean {
	const parts = p.split(/[\\/]/).filter(Boolean);
	if (parts.slice(0, -1).some((d) => /^(?:tests?|__tests__|specs?|__specs__)$/i.test(d))) return true;
	const file = parts[parts.length - 1] ?? "";
	return /(?:^|[._-])(?:tests?|specs?)(?:[._-]|$)/i.test(file.replace(/\.[^.]*$/, "")) || /\.(?:test|spec)\./i.test(file) || /(?:^|[._-])(?:tests|specs)\./i.test(file);
}

function callOf(b: Obj): WorkflowCall | undefined {
	const id = idOf(b.id);
	const name = smallOf(b.name);
	if (!id || !name) return undefined;
	const c: WorkflowCall = { id, name };
	const args = isObj(b.arguments) ? b.arguments : undefined;
	const lname = name.toLowerCase();
	if (SHELL_TOOLS.has(lname) && typeof args?.command === "string") {
		const a = analyzeCommand(args.command);
		if (a) Object.assign(c, a);
	} else if (MUTATION_TOOLS.has(lname)) {
		c.mutation = true;
		const p = [args?.path, args?.file_path, args?.filePath].find((x): x is string => typeof x === "string" && x.length > 0);
		if (p !== undefined) c.testNamedPath = testNamedPath(p);
	}
	return c;
}

export function extractWorkflowRecord(entry: unknown, line: number): WorkflowRecord | null {
	if (!Number.isInteger(line) || line < 1 || !isObj(entry) || typeof entry.type !== "string") return null;
	const e = entry;
	const id = idOf(e.id);
	const parentId = idOf(e.parentId);
	const rec = (kind: WorkflowRecord["kind"], m?: Obj): WorkflowRecord => {
		const r: WorkflowRecord = { id: id ?? `line:${line}`, line, kind };
		if (parentId) r.parentId = parentId;
		const at = timeOf(e, m);
		if (at !== undefined) r.at = at;
		const role = structuredRole(e, m);
		if (role) r.role = role;
		return r;
	};
	const withText = (r: WorkflowRecord, text: string | undefined) => {
		if (text === undefined) return;
		r.textBytes = Buffer.byteLength(text, "utf8");
		r.textHash = sha(text);
	};
	const notification = (r: WorkflowRecord, text: string | undefined) => {
		if (text !== undefined && WAKE_RE.test(text)) r.wakeHash = sha(text);
	};

	switch (e.type) {
		case "session": return rec("session");
		case "compaction": return rec("compaction");
		case "context_edit": case "branch_summary": return id ? rec("context-edit") : null;
		case "model_change": case "thinking_level_change": case "session_info": case "label": case "custom":
			return id ? rec("metadata") : null;
		case "custom_message": {
			const c = readContent(e.content);
			if (c.huge) return opaqueFor(e, line);
			const r = rec("notice");
			withText(r, c.text);
			if (e.customType === "subagent-notify" && c.text !== undefined) {
				const projected = projectNotifyReport(c.text);
				if (projected !== undefined) {
					r.deliveryHash = sha(projected.report); r.deliveryBytes = Buffer.byteLength(projected.report, "utf8");
					if (projected.alternate !== undefined) {
						r.deliveryAlternateHash = sha(projected.alternate);
						r.deliveryAlternateBytes = Buffer.byteLength(projected.alternate, "utf8");
					}
				}
			} else notification(r, c.text);
			return r;
		}
		case "message": break;
		default: return id ? opaqueFor(e, line) : null;
	}
	const m = e.message;
	if (!isObj(m)) return opaqueFor(e, line);
	const c = readContent(m.content);
	if (c.huge) return opaqueFor(e, line);
	switch (m.role) {
		case "user": {
			const r = rec("user", m);
			withText(r, c.text);
			notification(r, c.text);
			return r;
		}
		case "system": {
			const r = rec("system", m);
			// Subagent runtime: empty content + string sections (toolsAdded never counted). Unknown stays absent.
			const sec = isObj(m.sections) ? m.sections : undefined;
			const parts = sec ? ["preamble", "project_context", "cwd"].map((k) => sec[k]).filter((v): v is string => typeof v === "string") : [];
			if (parts.reduce((n, p) => n + p.length, 0) > MAX_TEXT_CHARS) return opaqueFor(e, line);
			if (parts.length > 0) {
				const joined = parts.join("");
				r.textBytes = Buffer.byteLength(joined, "utf8");
				r.textHash = sha(joined);
				if (typeof sec?.preamble === "string" && !r.role) { const d = anchoredRole(sec.preamble); if (d) r.role = d; }
			} else if (c.text !== undefined && c.text !== "") withText(r, c.text);
			return r;
		}
		case "assistant": {
			const r = rec("assistant", m);
			withText(r, c.text);
			const provider = smallOf(m.provider);
			if (provider) r.provider = provider;
			const stop = smallOf(m.stopReason);
			if (stop) r.stop = stop;
			if (m.stopReason === "error") r.providerError = true;
			if (m.stopReason === "stop" && c.calls.length === 0 && c.text !== undefined && c.text.trim() !== "") r.finalText = true;
			const calls = c.calls.map(callOf).filter((x): x is WorkflowCall => x !== undefined);
			if (calls.length) r.calls = calls;
			const usage = usageOf(m.usage);
			if (usage) r.usage = usage;
			return r;
		}
		case "toolResult": {
			const r = rec("tool-result", m);
			withText(r, c.text);
			const callId = idOf(m.toolCallId);
			if (callId) r.resultFor = callId;
			if (typeof m.isError === "boolean") r.isError = m.isError;
			const d = isObj(m.details) ? m.details : undefined;
			const x = d?.exitCode ?? d?.exit_code;
			if (typeof x === "number" && Number.isSafeInteger(x) && Math.abs(x) <= MAX_EXIT) r.exitCode = x;
			// Explicit metadata, or Pi's exact standard error-receipt marker on an isError receipt; otherwise unknown.
			if (d?.timedOut === true || d?.timeout === true) r.timeout = true;
			else if (m.isError === true && c.text !== undefined && /(?:^|\n\n)Command timed out after \d+ seconds$/.test(c.text)) r.timeout = true;
			return r;
		}
		default: return opaqueFor(e, line);
	}
}
