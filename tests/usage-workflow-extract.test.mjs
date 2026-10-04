// Pure normalization of one parsed JSONL object into a WorkflowRecord. Anonymized synthetic fixtures only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { extractWorkflowRecord, opaqueWorkflowRecord } from "../usage-extension/workflow/extract.ts";

const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const msg = (id, message, extra = {}) => ({ type: "message", id, parentId: "p0", timestamp: "2026-01-02T03:04:05.000Z", message, ...extra });
const user = (text, extra) => msg("u1", { role: "user", content: text }, extra);
const assistant = (content, over = {}, extra) => msg("a1", { role: "assistant", content, stopReason: "stop", provider: "prov", ...over }, extra);
const bash = (command, id = "c1") => assistant([{ type: "toolCall", id, name: "bash", arguments: { command } }], { stopReason: "toolUse" });
const call = (command) => extractWorkflowRecord(bash(command), 3).calls[0];
const NO_LEAK = ["SECRET-TOKEN-xyz", "private-body-text", "/home/anon/proj"];
const noLeak = (rec) => { const j = JSON.stringify(rec); for (const s of NO_LEAK) assert.ok(!j.includes(s), s); };

test("non-objects, bad lines and unidentifiable entries are null", () => {
	for (const bad of [null, undefined, 5, "x", [], [{}]]) assert.equal(extractWorkflowRecord(bad, 1), null);
	for (const line of [0, -1, 1.5, NaN, Infinity]) assert.equal(extractWorkflowRecord(user("hi"), line), null);
	assert.equal(extractWorkflowRecord({ type: "mystery" }, 1), null);
	assert.equal(extractWorkflowRecord({}, 1), null);
});

test("opaque helper and unsupported identifiable entries keep parent topology only", () => {
	assert.deepEqual(opaqueWorkflowRecord(7), { id: "line:7", line: 7, kind: "opaque" });
	const r = extractWorkflowRecord({ type: "mystery_x", id: "k1", parentId: "p9", data: { body: "SECRET-TOKEN-xyz" } }, 4);
	assert.deepEqual(r, { id: "k1", parentId: "p9", line: 4, kind: "opaque" });
	noLeak(r);
	assert.equal(extractWorkflowRecord({ type: "branch_summary", id: "b", parentId: null, summary: "private-body-text" }, 5).kind, "context-edit");
});

test("known Pi metadata keeps scalar topology as metadata, not opaque; context_edit is distinct", () => {
	for (const type of ["model_change", "thinking_level_change", "session_info", "label", "custom"]) {
		const r = extractWorkflowRecord({ type, id: "m1", parentId: "p1", timestamp: "2026-01-02T03:04:05.000Z", name: "private-body-text", data: { x: "SECRET-TOKEN-xyz" }, label: "private-body-text", modelId: "SECRET-TOKEN-xyz" }, 6);
		assert.equal(r.kind, "metadata", type);
		assert.equal(r.id, "m1"); assert.equal(r.parentId, "p1"); assert.equal(r.line, 6);
		assert.equal(r.at, Date.parse("2026-01-02T03:04:05.000Z"));
		assert.deepEqual(Object.keys(r).sort(), ["at", "id", "kind", "line", "parentId"], type);
		noLeak(r);
	}
	const ce = extractWorkflowRecord({ type: "context_edit", id: "e1", parentId: "a1", edits: [{ body: "private-body-text" }] }, 7);
	assert.equal(ce.kind, "context-edit"); assert.equal(ce.parentId, "a1"); noLeak(ce);
});

test("session, compaction records carry scalars only", () => {
	const s = extractWorkflowRecord({ type: "session", id: "s1", cwd: "/home/anon/proj", timestamp: "2026-01-02T00:00:00Z" }, 1);
	assert.equal(s.kind, "session"); assert.equal(s.line, 1); assert.equal(s.id, "s1"); noLeak(s);
	const c = extractWorkflowRecord({ type: "compaction", id: "cp", parentId: "a1", summary: "private-body-text", tokensBefore: 10 }, 9);
	assert.deepEqual({ k: c.kind, p: c.parentId, id: c.id }, { k: "compaction", p: "a1", id: "cp" }); noLeak(c);
});

test("exact text hash and UTF-8 byte count preserve whitespace and non-ASCII", () => {
	const text = "  héllo ✓ 日本\r\n\t trailing  \n";
	const r = extractWorkflowRecord(user(text), 2);
	assert.equal(r.kind, "user");
	assert.equal(r.textHash, sha(text));
	assert.equal(r.textBytes, Buffer.byteLength(text, "utf8"));
	assert.notEqual(r.textBytes, text.length);
	assert.notEqual(r.textHash, sha(text.trim()));
	assert.equal(r.parentId, "p0");
	assert.equal(r.line, 2);
	assert.equal(r.at, Date.parse("2026-01-02T03:04:05.000Z"));
});

test("visible text excludes thinking, image and signature blocks", () => {
	const r = extractWorkflowRecord(assistant([
		{ type: "thinking", thinking: "private-body-text", thinkingSignature: "SECRET-TOKEN-xyz" },
		{ type: "text", text: "visible" },
		{ type: "image", data: "SECRET-TOKEN-xyz", mimeType: "image/png" },
	]), 2);
	assert.equal(r.textHash, sha("visible")); assert.equal(r.textBytes, 7); noLeak(r);
	const empty = extractWorkflowRecord(user(""), 2);
	assert.equal(empty.textBytes, 0); assert.equal(empty.textHash, sha(""));
});

test("counters: known values only, zero is zero, missing is unknown, invalid dropped", () => {
	const full = extractWorkflowRecord(assistant("x", { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 2.5, reasoning: 3, cost: { total: 0.25 } } }), 2);
	assert.deepEqual(full.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 2.5, reasoning: 3, cost: 0.25 });
	const zero = extractWorkflowRecord(assistant("x", { usage: { input: 0, output: 0, cost: { total: 0 } } }), 2);
	assert.deepEqual(zero.usage, { input: 0, output: 0, cost: 0 });
	assert.equal("cacheRead" in zero.usage, false);
	assert.equal(extractWorkflowRecord(assistant("x"), 2).usage, undefined);
	assert.equal(extractWorkflowRecord(assistant("x", { usage: {} }), 2).usage, undefined);
	const bad = extractWorkflowRecord(assistant("x", { usage: { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: "7", reasoning: null, cost: { total: -0.1 } } }), 2);
	assert.equal(bad.usage, undefined);
	const mixed = extractWorkflowRecord(assistant("x", { usage: { input: 4, output: -2 } }), 2);
	assert.deepEqual(mixed.usage, { input: 4 });
});

test("provider errors come only from actual assistant error stop reasons", () => {
	const err = extractWorkflowRecord(assistant([], { stopReason: "error", errorMessage: "private-body-text" }), 2);
	assert.equal(err.providerError, true); assert.equal(err.stop, "error"); assert.equal(err.provider, "prov"); noLeak(err);
	assert.notEqual(extractWorkflowRecord(assistant("ok"), 2).providerError, true);
	assert.notEqual(extractWorkflowRecord(assistant("error: boom", { stopReason: "stop" }), 2).providerError, true);
	assert.notEqual(extractWorkflowRecord(user("stopReason error"), 2).providerError, true);
	assert.notEqual(extractWorkflowRecord(msg("t", { role: "toolResult", toolCallId: "c", content: "error", isError: true }), 2).providerError, true);
	assert.notEqual(extractWorkflowRecord(assistant("x", { stopReason: "aborted" }), 2).providerError, true);
});

test("finalText needs stop plus visible text and excludes tool-call-only responses", () => {
	assert.equal(extractWorkflowRecord(assistant("Done."), 2).finalText, true);
	assert.notEqual(extractWorkflowRecord(assistant("   \n"), 2).finalText, true);
	assert.notEqual(extractWorkflowRecord(assistant("text", { stopReason: "aborted" }), 2).finalText, true);
	assert.notEqual(extractWorkflowRecord(assistant("text", { stopReason: "error" }), 2).finalText, true);
	assert.notEqual(extractWorkflowRecord(assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }], { stopReason: "stop" }), 2).finalText, true);
	assert.notEqual(extractWorkflowRecord(assistant([{ type: "text", text: "plan" }, { type: "toolCall", id: "c", name: "read", arguments: {} }], { stopReason: "toolUse" }), 2).finalText, true);
});

test("tool results pair by actual call id with explicit status only", () => {
	const r = extractWorkflowRecord(msg("t1", { role: "toolResult", toolCallId: "call-9", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, details: { exitCode: 0 } }), 5);
	assert.equal(r.kind, "tool-result"); assert.equal(r.resultFor, "call-9"); assert.equal(r.isError, false); assert.equal(r.exitCode, 0);
	assert.equal(r.textHash, sha("out"));
	const nz = extractWorkflowRecord(msg("t2", { role: "toolResult", toolCallId: "c", content: "x", isError: true, details: { exit_code: 2, timedOut: true } }), 5);
	assert.equal(nz.isError, true); assert.equal(nz.exitCode, 2); assert.equal(nz.timeout, true);
	const none = extractWorkflowRecord(msg("t3", { role: "toolResult", toolCallId: "c", content: "exit code 1 failed" }), 5);
	assert.equal(none.exitCode, undefined); assert.equal(none.isError, undefined);
	const badExit = extractWorkflowRecord(msg("t4", { role: "toolResult", toolCallId: "c", content: "x", details: { exitCode: "0" } }), 5);
	assert.equal(badExit.exitCode, undefined);
	assert.equal(extractWorkflowRecord(msg("t5", { role: "toolResult", content: "x" }), 5).resultFor, undefined);
});

test("assistant tool calls keep actual ids and no arguments", () => {
	const r = extractWorkflowRecord(assistant([
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/home/anon/proj/a.ts" } },
		{ type: "toolCall", name: "bash", arguments: { command: "echo SECRET-TOKEN-xyz" } },
		{ type: "toolCall", id: "call-2", name: "grep", arguments: { pattern: "private-body-text" } },
	], { stopReason: "toolUse" }), 3);
	assert.deepEqual(r.calls.map((c) => c.id), ["call-1", "call-2"]);
	assert.deepEqual(r.calls.map((c) => c.name), ["read", "grep"]);
	noLeak(r);
});

test("edit/write calls use explicit path names only; paths omitted; test names syntactic", () => {
	const mk = (name, args) => extractWorkflowRecord(assistant([{ type: "toolCall", id: "m", name, arguments: args }], { stopReason: "toolUse" }), 3).calls[0];
	const w = mk("write", { path: "/home/anon/proj/src/app.ts", content: "private-body-text" });
	assert.equal(w.mutation, true); assert.equal("pathHash" in w, false); assert.equal(w.testNamedPath, false);
	assert.ok(!JSON.stringify(w).includes(sha("/home/anon/proj/src/app.ts")));
	noLeak(w);
	for (const p of ["tests/a.mjs", "src/a.test.ts", "src/a_spec.rb", "pkg/__tests__/x.js", "test_a.py", "a-tests.ts"]) assert.equal(mk("edit", { path: p }).testNamedPath, true, p);
	for (const p of ["src/contest.ts", "src/latest.ts", "src/attest/x.ts"]) assert.equal(mk("edit", { file_path: p }).testNamedPath, false, p);
	const nopath = mk("edit", { edits: [{ oldText: "a", newText: "b" }] });
	assert.equal(nopath.mutation, true); assert.equal("pathHash" in nopath, false); assert.equal(nopath.testNamedPath, undefined);
	assert.notEqual(mk("read", { path: "a.ts" }).mutation, true);
	assert.notEqual(call("sed -i s/a/b/ src/x.ts").mutation, true);
});

test("outer shell test/check, filter, force-exit flags", () => {
	for (const c of ["pnpm test", "npm run test", "pnpm exec vitest run", "npx tsc --noEmit", "node --test tests/a.test.mjs", "cargo test", "cd x && pytest -q", "FOO=1 go test ./...", "uv run pytest", "pnpm run typecheck", "make check"]) {
		assert.equal(call(c).test, true, c);
	}
	for (const c of ["echo done", "ls tests", "git status", "npm install", "cat README.md", "pnpm install"]) assert.notEqual(call(c).test, true, c);
	assert.equal(call("pnpm test").filtered, false);
	assert.equal(call("pnpm test | tail -5").filtered, true);
	assert.equal(call("pytest 2>&1 | grep FAIL").filtered, true);
	assert.equal(call("vitest run --testNamePattern foo").filtered, true);
	assert.equal(call("pytest -k foo").filtered, true);
	assert.equal(call("cargo test widget").filtered, true);
	assert.equal(call("pnpm test").forcedExit, false);
	assert.equal(call("jest --forceExit").forcedExit, true);
	assert.equal(call("pnpm test || true").forcedExit, true);
	assert.equal(call("pnpm test || exit 0").forcedExit, true);
	assert.equal(call("pnpm test && echo ok").forcedExit, false);
});

test("quoted, substituted and heredoc bodies are not executed outer commands", () => {
	for (const c of [
		"echo 'pnpm test'",
		'echo "pnpm test | tail"',
		"bash -c 'pnpm test'",
		"cat <<'EOF'\npnpm test\nEOF",
		"python3 - <<PY\nimport os\nos.system('pytest')\nPY",
		"cat <<-EOF\n\tcargo test\n\tEOF",
		"echo $(pnpm test)",
		"echo `pnpm test`",
		"printf '%s' \"vitest\" # pnpm test",
	]) assert.notEqual(call(c).test, true, c);
	// heredoc ends; later outer commands are still real
	assert.equal(call("cat <<EOF\nx\nEOF\npnpm test").test, true);
	assert.equal(call("cat <<'EOF'\n|| true --forceExit | tail\nEOF").baselineRead, false);
	const c = call("pnpm test <<'EOF'\n| tail --forceExit || true\nEOF");
	assert.equal(c.test, true); assert.equal(c.filtered, false); assert.equal(c.forcedExit, false);
	assert.equal(call("pnpm test -- --grep 'a | b'").filtered, true);
	assert.equal(call("pnpm test 'x | tail'").filtered, false);
});

test("baseline read is only a literal outer git show REV:PATH", () => {
	assert.equal(call("git show HEAD:src/a.ts").baselineRead, true);
	assert.equal(call("git show abc1234:src/a.ts | head -5").baselineRead, true);
	assert.equal(call("git -C wt show main~1:src/a.ts").baselineRead, true);
	for (const c of ["cat src/a.ts", "head -40 src/a.ts", "sed -n '1,20p' src/a.ts", "cat report.md", "grep -n x src/a.ts", "git show HEAD", "git show --stat HEAD", "git log -p", "git diff HEAD:a b", "pnpm test | head -5",
		"echo 'git show HEAD:src/a.ts'", "cat <<EOF\ngit show HEAD:src/a.ts\nEOF", "git show \"HEAD:src/a.ts\"", "ls"]) {
		assert.equal(call(c).baselineRead, false, c);
	}
});

test("scripts/node.sh wrapper with test flags is check-looking; bodies are not inspected", () => {
	const c = call("scripts/node.sh --test --test-force-exit --test-timeout=15000 tests/a.test.mjs");
	assert.equal(c.test, true); assert.equal(c.forcedExit, true); assert.equal(c.filtered, false);
	assert.equal(call("bash scripts/node.sh --test tests/a.test.mjs").test, true);
	assert.equal(call("./scripts/node.sh --test").forcedExit, false);
	assert.notEqual(call("scripts/node.sh build.mjs").test, true);
	assert.notEqual(call("scripts/node.sh --version").test, true);
	assert.notEqual(call("python3 - <<'PY'\nimport subprocess\nsubprocess.run(['scripts/node.sh','--test','--test-force-exit'])\nPY").test, true);
	assert.notEqual(call("echo 'scripts/node.sh --test'").test, true);
	assert.notEqual(call("bash -c 'scripts/node.sh --test'").test, true);
});

test("non-shell or non-string commands are not analyzed", () => {
	const r = extractWorkflowRecord(assistant([
		{ type: "toolCall", id: "a", name: "read", arguments: { command: "pnpm test" } },
		{ type: "toolCall", id: "b", name: "bash", arguments: { command: 42 } },
		{ type: "toolCall", id: "c", name: "bash", arguments: {} },
	], { stopReason: "toolUse" }), 3);
	for (const c of r.calls) assert.equal(c.test, undefined);
	const huge = call("echo " + "x".repeat(200_000) + "\npnpm test");
	assert.equal(huge.test, undefined);
});

const WAKE = "pr-latch: PR 12 ready\nstatus: done\nreview body\n";
test("wake markers: literal line-start markers in user/custom notification records only", () => {
	for (const m of ["pr-latch:", "pro-latch:", "dot-latch:"]) {
		const r = extractWorkflowRecord(user(`${m} ready\nbody`), 2);
		assert.equal(r.wakeHash, sha(`${m} ready\nbody`), m);
	}
	const custom = extractWorkflowRecord({ type: "custom_message", id: "n1", parentId: "p", customType: "latch", content: WAKE, display: true }, 6);
	assert.equal(custom.kind, "notice"); assert.equal(custom.wakeHash, sha(WAKE));
	for (const t of ["I mentioned pr-latch: in prose", "PR-LATCH: x", "pr-latch x", "prlatch:", "xpr-latch: y", "dot_latch:"]) {
		assert.equal(extractWorkflowRecord(user(t), 2).wakeHash, undefined, t);
	}
	assert.equal(extractWorkflowRecord(assistant("pr-latch: ready"), 2).wakeHash, undefined);
	assert.equal(extractWorkflowRecord(msg("t", { role: "toolResult", toolCallId: "c", content: "pr-latch: ready" }), 2).wakeHash, undefined);
	assert.equal(extractWorkflowRecord(msg("s", { role: "system", content: "pr-latch: ready" }), 2).wakeHash, undefined);
	assert.equal(extractWorkflowRecord(user([{ type: "thinking", thinking: "pr-latch: x" }, { type: "text", text: "hello" }]), 2).wakeHash, undefined);
});

const notify = (report, { name = "fixer", trailer = "\n\nOutput saved to: /home/anon/proj/out.md (12 lines)" } = {}) => ({
	type: "custom_message", id: "n2", parentId: "p", customType: "subagent-notify", display: true,
	content: `Background task completed: **${name}**\n\n${name}:\n${report}${trailer}`,
});

test("latch markers alone never project a delivery (no supported wrapper assumed)", () => {
	for (const t of [`pr-latch: ready\nbody\n`, `<task-notification>\npr-latch: ready\nbody\n</task-notification>`]) {
		const r = extractWorkflowRecord(user(t), 2);
		assert.ok(r.wakeHash);
		assert.equal(r.deliveryHash, undefined); assert.equal(r.deliveryBytes, undefined);
	}
});

test("subagent-notify delivery: exact REPORT slice incl. final newline; independent of wakeHash", () => {
	const report = "Report line 1\n  indented ✓\nlast line\n";
	const r = extractWorkflowRecord(notify(report), 6);
	assert.equal(r.kind, "notice");
	assert.equal(r.wakeHash, undefined);
	assert.equal(r.deliveryHash, sha(report));
	assert.equal(r.deliveryBytes, Buffer.byteLength(report, "utf8"));
	assert.equal(r.textHash, sha(notify(report).content));
	noLeak(r);
	// no final newline: not invented
	const nofinal = extractWorkflowRecord(notify("x y"), 6);
	assert.equal(nofinal.deliveryHash, sha("x y"));
	// multiple trailing newlines preserved exactly
	assert.equal(extractWorkflowRecord(notify("x\n\n"), 6).deliveryHash, sha("x\n\n"));
	// whitespace differences are different hashes (no trimming)
	assert.notEqual(extractWorkflowRecord(notify(report + " "), 6).deliveryHash, r.deliveryHash);
	// report text containing the trailer phrase keeps only the final envelope
	const tricky = "a\n\nOutput saved to: inner\nb\n";
	assert.equal(extractWorkflowRecord(notify(tricky), 6).deliveryHash, sha(tricky));
	// tool-result comparison inputs
	const t = extractWorkflowRecord(msg("t", { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: report }] }), 7);
	assert.equal(r.deliveryHash, t.textHash); assert.equal(r.deliveryBytes, t.textBytes);
});

test("subagent-notify controls: file-only, partial, read-required, malformed, different type", () => {
	const none = (rec, why) => { const r = extractWorkflowRecord(rec, 6); assert.equal(r.deliveryHash, undefined, why); assert.equal(r.deliveryBytes, undefined, why); assert.equal(r.wakeHash, undefined, why); };
	none(notify(""), "empty report");
	none(notify("\n"), "whitespace report");
	none(notify("Output saved to: /home/anon/proj/out.md"), "file-only line");
	none(notify("report/out.md"), "path-only");
	none(notify("head\n... [truncated]\n"), "partial preview");
	none(notify("head\n[preview]\n"), "preview marker");
	none(notify("full\n", { trailer: "\n\nOutput saved to: /p/o.md\nOutput truncated; read the file for the full report." }), "read-required trailer");
	none(notify("full\n", { trailer: "" }), "no output-saved envelope");
	none({ ...notify("full\n"), content: "Background task completed: **fixer**\n\nother:\nfull\n\nOutput saved to: /p" }, "name mismatch");
	none({ ...notify("full\n"), content: "Background task failed: **fixer**\n\nfixer:\nfull\n\nOutput saved to: /p" }, "different header");
	none({ ...notify("full\n"), customType: "other" }, "different customType");
	none({ ...notify("full\n"), content: [{ type: "text", text: "x" }] }, "non-string content");
	none(user(notify("full\n").content), "user record is not a subagent-notify");
});

const sysEntry = (sections, over = {}, extra = {}) => ({ type: "message", id: "sys1", parentId: "p0", timestamp: "2026-01-02T03:04:05.000Z", message: { role: "system", content: "", sections, toolsAdded: [{ name: "SECRET-TOKEN-xyz", description: "private-body-text" }], ...over }, ...extra });

test("system sections: exact string-section bytes, tools excluded, no false zero, anchored role", () => {
	const sections = { preamble: '<active_agent name="scout-readonly"/>\nYou are ünïcode ✓\n', project_context: "ctx  \n", cwd: "/home/anon/proj" };
	const r = extractWorkflowRecord(sysEntry(sections), 5);
	assert.equal(r.kind, "system");
	const joined = sections.preamble + sections.project_context + sections.cwd;
	assert.equal(r.textBytes, Buffer.byteLength(joined, "utf8"));
	assert.equal(r.textHash, sha(joined));
	assert.equal(r.role, "scout-readonly");
	assert.equal(r.parentId, "p0");
	assert.ok(!JSON.stringify(r).includes("SECRET-TOKEN-xyz")); noLeak(r);
	// only known string sections count; non-string and unknown sections are ignored
	const partial = extractWorkflowRecord(sysEntry({ preamble: "abc", project_context: 7, cwd: null, extra: "zzzz" }), 5);
	assert.equal(partial.textBytes, 3); assert.equal(partial.textHash, sha("abc"));
	// empty content + no usable sections => unknown, never zero
	for (const s of [undefined, {}, { preamble: 5 }, "str", []]) {
		const u = extractWorkflowRecord(sysEntry(s), 5);
		assert.equal(u.kind, "system"); assert.equal(u.textBytes, undefined); assert.equal(u.textHash, undefined);
	}
	// a genuinely empty known string section is a known zero
	assert.equal(extractWorkflowRecord(sysEntry({ preamble: "" }), 5).textBytes, 0);
	// plain string-content system messages still count
	const plain = extractWorkflowRecord({ type: "message", id: "s", message: { role: "system", content: "plain é" } }, 5);
	assert.equal(plain.textBytes, Buffer.byteLength("plain é"));
});

test("roles: anchored active_agent in initial preamble or structured metadata only", () => {
	const role = (preamble, over, extra) => extractWorkflowRecord(sysEntry({ preamble }, over, extra), 5).role;
	assert.equal(role('<active_agent name="tdd-worker"/>\nbody'), "tdd-worker");
	assert.equal(role('<active_agent name="a.b_c-1"/>'), "a.b_c-1");
	// parent topology is NOT a role gate (analyzer scopes initial records)
	assert.equal(role('<active_agent name="scout"/>', {}, { parentId: undefined }), "scout");
	assert.equal(role('<active_agent name="scout"/>', {}, { parentId: "deep" }), "scout");
	for (const p of [
		'preface\n<active_agent name="scout"/>', ' <active_agent name="scout"/>', '<active_agent name="bad role!"/>', '<active_agent name=""/>',
		'<active_agent name="' + "x".repeat(100) + '"/>', '<active_agent name="x">', "You are `tdd-worker`: a writer.", "Role: planner", "Please fix the planner module",
	]) assert.equal(role(p), undefined, p);
	// role only from the preamble section, not other sections or content
	assert.equal(extractWorkflowRecord(sysEntry({ project_context: '<active_agent name="scout"/>' }), 5).role, undefined);
	assert.equal(extractWorkflowRecord({ type: "message", id: "s", message: { role: "system", content: '<active_agent name="scout"/>' } }, 5).role, undefined);
	// user/assistant prose never declares a role
	assert.equal(extractWorkflowRecord(user('<active_agent name="scout"/>'), 2).role, undefined);
	assert.equal(extractWorkflowRecord(user("Role: planner"), 2).role, undefined);
	assert.equal(extractWorkflowRecord(assistant('<active_agent name="x"/>'), 2).role, undefined);
	// structured metadata
	assert.equal(extractWorkflowRecord({ ...user("hi"), agentRole: "reviewer" }, 2).role, "reviewer");
	assert.equal(extractWorkflowRecord({ type: "session", id: "s", agent: { name: "scout" } }, 1).role, "scout");
	assert.equal(extractWorkflowRecord({ ...user("hi"), agentRole: "bad role!!" }, 2).role, undefined);
	assert.equal(extractWorkflowRecord({ ...user("hi"), agentRole: "x".repeat(200) }, 2).role, undefined);
});

test("timeout: explicit metadata or exact standard receipt marker with isError=true only", () => {
	const res = (text, over = {}, details) => extractWorkflowRecord(msg("t", { role: "toolResult", toolCallId: "c", content: [{ type: "text", text }], ...over, ...(details ? { details } : {}) }), 5);
	assert.equal(res("out\n\nCommand timed out after 30 seconds", { isError: true }).timeout, true);
	assert.equal(res("Command timed out after 5 seconds", { isError: true }).timeout, true);
	assert.equal(res("x", {}, { timedOut: true }).timeout, true);
	assert.equal(res("x", {}, { timeout: true }).timeout, true);
	for (const [text, over] of [
		["out\n\nCommand timed out after 30 seconds", {}],
		["out\n\nCommand timed out after 30 seconds", { isError: false }],
		["the test said Command timed out after 30 seconds in prose", { isError: true }],
		["out\nCommand timed out after 30 seconds", { isError: true }],
		["Command timed out after 30 seconds\ntrailing", { isError: true }],
		["Command timed out after many seconds", { isError: true }],
		["command timed out after 30 seconds", { isError: true }],
		["timeout", { isError: true }],
	]) assert.equal(res(text, over).timeout, undefined, text);
	assert.equal(res("x", {}, { timedOut: "yes" }).timeout, undefined);
	// no marker => unknown, never false
	assert.equal("timeout" in res("plain", { isError: true }), false);
});

test("schema bounds: huge or malformed bodies are opaque scalars; strings bounded", () => {
	const huge = extractWorkflowRecord(user("x".repeat(3_000_000), { id: "big", parentId: "p" }), 8);
	assert.deepEqual(huge, { id: "big", parentId: "p", line: 8, kind: "opaque" });
	const manyCalls = extractWorkflowRecord(assistant(Array.from({ length: 500 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "read", arguments: {} })), { stopReason: "toolUse" }), 3);
	assert.ok(manyCalls.calls.length <= 64);
	const odd = extractWorkflowRecord(user("hi", { id: "i".repeat(1000), parentId: "q".repeat(1000) }), 11);
	assert.equal(odd.id, "line:11"); assert.equal(odd.parentId, undefined);
	const noId = extractWorkflowRecord({ type: "message", message: { role: "user", content: "hi" } }, 12);
	assert.equal(noId.id, "line:12");
	assert.equal(extractWorkflowRecord(assistant("x", { provider: "bad provider\n" + "z".repeat(500) }), 2).provider, undefined);
	assert.equal(extractWorkflowRecord(assistant("x", { stopReason: "s".repeat(500) }), 2).stop, undefined);
	const weird = extractWorkflowRecord(msg("w", { role: "bashExecution", command: "SECRET-TOKEN-xyz" }), 3);
	assert.equal(weird.kind, "opaque"); noLeak(weird);
	const nomsg = extractWorkflowRecord({ type: "message", id: "z", message: "private-body-text" }, 3);
	assert.equal(nomsg.kind, "opaque"); noLeak(nomsg);
});

test("timestamps: usable only; unknown stays absent", () => {
	assert.equal(extractWorkflowRecord({ ...user("x"), timestamp: "garbage" }, 2).at, undefined);
	assert.equal(extractWorkflowRecord({ ...user("x"), timestamp: undefined }, 2).at, undefined);
	const m = extractWorkflowRecord(msg("a", { role: "user", content: "x", timestamp: 1700000000000 }, { timestamp: "garbage" }), 2);
	assert.equal(m.at, 1700000000000);
	assert.equal(extractWorkflowRecord(msg("a", { role: "user", content: "x", timestamp: -5 }, { timestamp: undefined }), 2).at, undefined);
});

test("no raw body, command, path, secret, thought, image or signature survives", () => {
	const r = extractWorkflowRecord(assistant([
		{ type: "thinking", thinking: "private-body-text", thinkingSignature: "SECRET-TOKEN-xyz" },
		{ type: "text", text: "private-body-text" },
		{ type: "toolCall", id: "c", name: "bash", arguments: { command: "pnpm test SECRET-TOKEN-xyz /home/anon/proj" } },
		{ type: "toolCall", id: "d", name: "write", arguments: { path: "/home/anon/proj/a.ts", content: "SECRET-TOKEN-xyz" } },
	], { stopReason: "toolUse", usage: { input: 1, cost: { total: 1 } }, errorMessage: "SECRET-TOKEN-xyz", responseId: "SECRET-TOKEN-xyz" }), 3);
	noLeak(r);
	const u = extractWorkflowRecord(user("private-body-text SECRET-TOKEN-xyz /home/anon/proj"), 3); noLeak(u);
});
