import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectUsageData } from "../usage-extension/data.ts";
import {
	claudeCodeTokenAmount,
	codexCliTokenAmount,
	collectNamedFiles,
	collectOpenCodeMessageFiles,
	disabledUsageSources,
	estimateUsd,
	canonicalProvider,
	grokBuildTokenAmount,
	mapOpenCodeProvider,
	openCodeTokenAmount,
	freeTierUsd,
	parseClaudeCodeBuffer,
	parseCodexCliBuffer,
	parseGrokBuildBuffer,
	parseOpenCodeGoBuffer,
	parseUsageSourcesSetting,
} from "../usage-extension/sources.ts";

const NOW = new Date(2026, 6, 15, 12, 0, 0);
const TS_TODAY = new Date(2026, 6, 15, 9, 0, 0).getTime();
const TS_TODAY_ISO = new Date(TS_TODAY).toISOString();
const TS_TODAY_SECONDS = Math.floor(TS_TODAY / 1000);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "usage-sources-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	return { root, sessionsDir, cachePath: join(root, "cache.json") };
}

function piSession(id, ts, cwd = "/tmp") {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd });
}

function piAssistant({ ts, provider = "anthropic", model = "claude-opus-5", cost = 1, input = 10, output = 5, cacheRead = 0, cacheWrite = 0 }) {
	return JSON.stringify({
		type: "message",
		id: "m1",
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

function sourcesFor(partial) {
	const disabled = disabledUsageSources();
	return { ...disabled, ...partial };
}

// =============================================================================
// Settings
// =============================================================================

test("parseUsageSourcesSetting defaults every extra source off", () => {
	assert.deepEqual(parseUsageSourcesSetting("{}"), disabledUsageSources());
	assert.deepEqual(parseUsageSourcesSetting("{"), disabledUsageSources());
	assert.deepEqual(parseUsageSourcesSetting('{"usage-extension":{"exportDir":"~/Downloads"}}'), disabledUsageSources());
});

test("parseUsageSourcesSetting enables default roots from booleans and honors path overrides", () => {
	const home = "/Users/greg";
	const env = {};
	const parsed = parseUsageSourcesSetting(
		JSON.stringify({
			"usage-extension": {
				sources: {
					claudeCode: true,
					codexCli: { path: "~/codex-alt" },
					grokBuild: { enabled: false, path: "/unused" },
				},
			},
		}),
		home,
		env,
	);
	assert.equal(parsed.claudeCode.enabled, true);
	assert.deepEqual(parsed.claudeCode.roots, [
		join(home, ".claude", "projects"),
		join(home, ".config", "claude", "projects"),
	]);
	assert.equal(parsed.codexCli.enabled, true);
	assert.deepEqual(parsed.codexCli.roots, [join(home, "codex-alt")]);
	assert.equal(parsed.grokBuild.enabled, false);
	assert.deepEqual(parsed.grokBuild.roots, []);
	assert.equal(parsed.opencodeGo.enabled, false);
});

test("parseUsageSourcesSetting prefers CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME", () => {
	const parsed = parseUsageSourcesSetting(
		JSON.stringify({ "usage-extension": { sources: { claudeCode: true, codexCli: true, grokBuild: true, opencodeGo: true } } }),
		"/home/u",
		{
			CLAUDE_CONFIG_DIR: "/custom/claude",
			CODEX_HOME: "/custom/codex",
			GROK_HOME: "~/g",
			OPENCODE_DATA_DIR: "/custom/oc,/backup/oc",
		},
	);
	assert.deepEqual(parsed.claudeCode.roots, [join("/custom/claude", "projects")]);
	assert.deepEqual(parsed.codexCli.roots, [join("/custom/codex", "sessions")]);
	assert.deepEqual(parsed.grokBuild.roots, [join("/home/u", "g", "sessions")]);
	assert.deepEqual(parsed.opencodeGo.roots, ["/custom/oc", "/backup/oc"]);
});

test("parseUsageSourcesSetting accepts opencode as an alias for opencodeGo", () => {
	const parsed = parseUsageSourcesSetting(
		JSON.stringify({ "usage-extension": { sources: { opencode: true } } }),
		"/home/u",
		{},
	);
	assert.equal(parsed.opencodeGo.enabled, true);
	assert.deepEqual(parsed.opencodeGo.roots, [join("/home/u", ".local", "share", "opencode")]);
});

// =============================================================================
// Token mapping
// =============================================================================

test("claudeCodeTokenAmount keeps Anthropic uncached input separate from cache create/read", () => {
	assert.deepEqual(
		claudeCodeTokenAmount({
			input_tokens: 2,
			cache_creation_input_tokens: 15836,
			cache_read_input_tokens: 22725,
			output_tokens: 294,
			output_tokens_details: { thinking_tokens: 40 },
		}),
		{ cost: 0, input: 2, output: 294, cacheRead: 22725, cacheWrite: 15836, reasoning: 40 },
	);
});

test("codexCliTokenAmount splits inclusive input_tokens and ignores missing cost", () => {
	assert.deepEqual(
		codexCliTokenAmount({
			input_tokens: 40412,
			cached_input_tokens: 29568,
			cache_write_input_tokens: 12,
			output_tokens: 852,
			reasoning_output_tokens: 516,
			total_tokens: 41264,
		}),
		{ cost: 0, input: 10844, output: 852, cacheRead: 29568, cacheWrite: 12, reasoning: 516 },
	);
});

test("codexCliTokenAmount clamps when cached exceeds input", () => {
	assert.deepEqual(codexCliTokenAmount({ input_tokens: 10, cached_input_tokens: 40, output_tokens: 1 }), {
		cost: 0,
		input: 0,
		output: 1,
		cacheRead: 40,
		cacheWrite: 0,
		reasoning: 0,
	});
});

test("estimateUsd uses Pi catalog rates per million tokens", () => {
	assert.equal(
		estimateUsd("anthropic", "claude-opus-5", {
			cost: 0,
			input: 2,
			output: 294,
			cacheRead: 22725,
			cacheWrite: 15836,
			reasoning: 0,
		}),
		(2 * 5 + 294 * 25 + 22725 * 0.5 + 15836 * 6.25) / 1_000_000,
	);
	assert.equal(
		estimateUsd("anthropic", "claude-haiku-4-5-20251001", {
			cost: 0,
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
		}),
		1,
	);
	assert.equal(
		estimateUsd("anthropic", "claude-opus-4-8", {
			cost: 0,
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
		}),
		5,
	);
	assert.equal(
		estimateUsd("xai", "grok-4.6-build", {
			cost: 0,
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
		}),
		2,
	);
});

test("estimateUsd matches zcode GLM model ids case-insensitively", () => {
	// Session logs record the zcode-re models in Pi's registered casing; the
	// provider folds into zai before pricing.
	const amount = { cost: 0, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	assert.equal(estimateUsd("zai", "GLM-5.3-Flash", { ...amount }), 0.15);
	assert.equal(estimateUsd("zai", "GLM-5.3", { ...amount }), 1.4);
	assert.equal(estimateUsd("zai", "glm-5.3-flash", { ...amount }), 0.15);
	// Unknown zcode-re model falls back to the provider's flagship rates.
	assert.equal(estimateUsd("zcode-re", "glm-future", { ...amount }), 1.4);
});

test("freeTierUsd estimates list-priced cost for free-tier models and passes paid usage through", () => {
	const amount = { cost: 0, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	// ZCode promo/subscription usage records $0 — show what tokens cost at list.
	assert.equal(freeTierUsd("zai", "GLM-5.3-Flash", { ...amount }), 0.15);
	assert.equal(freeTierUsd("zai", "GLM-5.3", { ...amount }), 1.4);
	assert.equal(freeTierUsd("zai", "glm-5.3-flash", { ...amount }), 0.15);
	// Recorded invoices are never repriced.
	assert.equal(freeTierUsd("anthropic", "claude-opus-5", { ...amount, cost: 3.5 }), 3.5);
});

test("grokBuildTokenAmount splits inclusive inputTokens and converts costUsdTicks", () => {
	assert.deepEqual(
		grokBuildTokenAmount({
			inputTokens: 24204,
			outputTokens: 357,
			cachedReadTokens: 896,
			cacheCreationTokens: 4,
			reasoningTokens: 217,
			costUsdTicks: 83650200,
		}),
		{ cost: 0.00836502, input: 23308, output: 357, cacheRead: 896, cacheWrite: 4, reasoning: 217 },
	);
});

// =============================================================================
// Parsers
// =============================================================================

test("parseClaudeCodeBuffer counts assistant usage and skips user/side-channel lines", async () => {
	const content = [
		JSON.stringify({ type: "user", sessionId: "s-cc", cwd: "/proj", timestamp: TS_TODAY_ISO, message: { role: "user", content: "hello" } }),
		JSON.stringify({
			type: "assistant",
			uuid: "a1",
			sessionId: "s-cc",
			cwd: "/proj",
			timestamp: TS_TODAY_ISO,
			effort: "high",
			message: {
				id: "msg_1",
				role: "assistant",
				model: "claude-opus-5",
				usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 3 },
			},
		}),
		JSON.stringify({ type: "attachment", sessionId: "s-cc" }),
	].join("\n");

	const parsed = await parseClaudeCodeBuffer(Buffer.from(content, "utf8"));
	assert.equal(parsed.sessionId, "s-cc");
	assert.equal(parsed.cwd, "/proj");
	assert.equal(parsed.messages.length, 1);
	assert.equal(parsed.messages[0].provider, "anthropic");
	assert.equal(parsed.messages[0].model, "claude-opus-5");
	assert.equal(parsed.messages[0].thinkingLevel, "high");
	assert.equal(parsed.messages[0].input, 2);
	assert.equal(parsed.messages[0].cacheWrite, 10);
	assert.equal(parsed.messages[0].cacheRead, 20);
	assert.equal(
		parsed.messages[0].cost,
		estimateUsd("anthropic", "claude-opus-5", {
			cost: 0,
			input: 2,
			output: 3,
			cacheRead: 20,
			cacheWrite: 10,
			reasoning: 0,
		}),
	);
	assert.equal(parsed.messages[0].sourceId, "a1");
	assert.equal(parsed.toolUsages.length, 0);
});

test("parseClaudeCodeBuffer does not JSON-parse huge non-assistant lines", async () => {
	const blob = "x".repeat(400_000);
	const content = [
		JSON.stringify({ type: "user", sessionId: "s-cc", message: { role: "user", content: blob } }),
		JSON.stringify({
			type: "assistant",
			uuid: "a2",
			sessionId: "s-cc",
			timestamp: TS_TODAY_ISO,
			message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } },
		}),
	].join("\n");
	const start = Date.now();
	const parsed = await parseClaudeCodeBuffer(Buffer.from(content, "utf8"));
	assert.ok(Date.now() - start < 500, "prefilter should skip the user blob");
	assert.equal(parsed.messages.length, 1);
	assert.equal(parsed.messages[0].input, 1);
});

test("parseCodexCliBuffer uses payload.usage not cumulative turn/thread totals", async () => {
	const content = [
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "session_meta",
			payload: { session_id: "s-cx", cwd: "/repo", id: "s-cx" },
		}),
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "turn_context",
			payload: { turn_id: "t1", model: "gpt-6-astra", effort: "xhigh", cwd: "/repo" },
		}),
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "token_usage_record",
			payload: {
				turn_id: "t1",
				response_id: "resp_1",
				usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9, reasoning_output_tokens: 3 },
				turn_token_usage: { input_tokens: 9999, cached_input_tokens: 0, output_tokens: 9999 },
				thread_token_usage: { input_tokens: 88888, output_tokens: 88888 },
			},
		}),
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "token_usage_record",
			payload: {
				turn_id: "t1",
				response_id: "resp_2",
				usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 0 },
			},
		}),
	].join("\n");

	const parsed = await parseCodexCliBuffer(Buffer.from(content, "utf8"));
	assert.equal(parsed.sessionId, "s-cx");
	assert.equal(parsed.messages.length, 2);
	assert.deepEqual(
		parsed.messages.map((m) => [m.provider, m.model, m.thinkingLevel, m.input, m.cacheRead, m.output]),
		[
			["openai-codex", "gpt-6-astra", "xhigh", 60, 40, 9],
			["openai-codex", "gpt-6-astra", "xhigh", 40, 10, 4],
		],
	);
	assert.equal(parsed.messages.reduce((sum, m) => sum + m.input + m.output, 0), 113);
});

test("parseCodexCliBuffer attributes a record to a later turn_context for the same turn_id", async () => {
	const content = [
		JSON.stringify({ timestamp: TS_TODAY_ISO, type: "session_meta", payload: { session_id: "s-cx" } }),
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "token_usage_record",
			payload: { turn_id: "late", response_id: "r", usage: { input_tokens: 8, output_tokens: 1 } },
		}),
		JSON.stringify({
			timestamp: TS_TODAY_ISO,
			type: "turn_context",
			payload: { turn_id: "late", model: "gpt-5.6-luna", effort: "medium" },
		}),
	].join("\n");
	const parsed = await parseCodexCliBuffer(Buffer.from(content, "utf8"));
	assert.equal(parsed.messages[0].model, "gpt-5.6-luna");
	assert.equal(parsed.messages[0].thinkingLevel, "medium");
});

test("parseGrokBuildBuffer counts only turn_completed rows and splits per modelUsage", async () => {
	const content = [
		JSON.stringify({
			timestamp: TS_TODAY_SECONDS,
			method: "session/update",
			params: { sessionId: "s-gk", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
		}),
		JSON.stringify({
			timestamp: TS_TODAY_SECONDS,
			params: {
				sessionId: "s-gk",
				update: {
					sessionUpdate: "turn_completed",
					prompt_id: "p1",
					usage: {
						inputTokens: 1000,
						outputTokens: 20,
						cachedReadTokens: 100,
						cacheCreationTokens: 5,
						reasoningTokens: 8,
						costUsdTicks: 20_000_000_000,
						modelUsage: {
							"grok-4.6-build": {
								inputTokens: 700,
								outputTokens: 12,
								cachedReadTokens: 80,
								cacheCreationTokens: 5,
								reasoningTokens: 6,
								costUsdTicks: 14_000_000_000,
							},
							"grok-4.6": {
								inputTokens: 300,
								outputTokens: 8,
								cachedReadTokens: 20,
								cacheCreationTokens: 0,
								reasoningTokens: 2,
								costUsdTicks: 6_000_000_000,
							},
						},
					},
				},
			},
		}),
		JSON.stringify({
			timestamp: TS_TODAY_SECONDS + 10,
			params: {
				sessionId: "s-gk",
				update: {
					sessionUpdate: "turn_completed",
					prompt_id: "p2",
					usage: {
						inputTokens: 50,
						outputTokens: 3,
						cachedReadTokens: 0,
						costUsdTicks: 1_000_000_000,
						modelUsage: {
							"grok-4.6-build": { inputTokens: 50, outputTokens: 3, cachedReadTokens: 0, costUsdTicks: 1_000_000_000 },
						},
					},
				},
			},
		}),
	].join("\n");

	const parsed = await parseGrokBuildBuffer(Buffer.from(content, "utf8"));
	assert.equal(parsed.sessionId, "s-gk");
	assert.equal(parsed.messages.length, 3);
	assert.deepEqual(
		parsed.messages.map((m) => [m.provider, m.model, m.input, m.cacheRead, m.cost]),
		[
			["xai", "grok-4.6-build", 620, 80, 1.4],
			["xai", "grok-4.6", 280, 20, 0.6],
			["xai", "grok-4.6-build", 50, 0, 0.1],
		],
	);
	assert.equal(parsed.messages[0].timestamp, TS_TODAY);
});

test("parseGrokBuildBuffer does not treat session-cumulative values as later turns", async () => {
	const content = [
		JSON.stringify({
			timestamp: 1_000_000,
			params: {
				sessionId: "s",
				update: {
					sessionUpdate: "turn_completed",
					prompt_id: "a",
					usage: { inputTokens: 600_000, outputTokens: 10, modelUsage: { "grok-4.6-build": { inputTokens: 600_000, outputTokens: 10 } } },
				},
			},
		}),
		JSON.stringify({
			timestamp: 1_000_010,
			params: {
				sessionId: "s",
				update: {
					sessionUpdate: "turn_completed",
					prompt_id: "b",
					usage: { inputTokens: 80_000, outputTokens: 4, modelUsage: { "grok-4.6-build": { inputTokens: 80_000, outputTokens: 4 } } },
				},
			},
		}),
	].join("\n");
	const parsed = await parseGrokBuildBuffer(Buffer.from(content, "utf8"));
	assert.equal(parsed.messages.reduce((sum, m) => sum + m.input, 0), 680_000);
});

test("collectNamedFiles finds only updates.jsonl", async (t) => {
	const { root } = fixture(t);
	const dir = join(root, "sessions", "proj", "sid");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "updates.jsonl"), "{}\n");
	writeFileSync(join(dir, "chat_history.jsonl"), "{}\n");
	writeFileSync(join(dir, "events.jsonl"), "{}\n");
	const files = await collectNamedFiles(join(root, "sessions"), "updates.jsonl");
	assert.deepEqual(files, [join(dir, "updates.jsonl")]);
});

// =============================================================================
// Collection: opt-in, merge, no double-count
// =============================================================================

test("collectUsageData stays Pi-only when extra sources are disabled even if extra files exist", async (t) => {
	const { root, sessionsDir, cachePath } = fixture(t);
	writeFileSync(join(sessionsDir, "pi.jsonl"), [piSession("s1", TS_TODAY), piAssistant({ ts: TS_TODAY, cost: 2, input: 10 })].join("\n") + "\n");
	const ccDir = join(root, "claude");
	mkdirSync(ccDir, { recursive: true });
	writeFileSync(
		join(ccDir, "cc.jsonl"),
		JSON.stringify({
			type: "assistant",
			sessionId: "cc1",
			uuid: "u",
			timestamp: TS_TODAY_ISO,
			message: { model: "claude-opus-5", usage: { input_tokens: 999, output_tokens: 999 } },
		}) + "\n",
	);

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({ claudeCode: { enabled: false, roots: [ccDir] } }),
	});
	assert.equal(data.allTime.totals.cost, 2);
	assert.equal(data.allTime.totals.messages, 1);
	assert.equal(data.allTime.providers.get("anthropic").tokens.input, 10);
});

test("collectUsageData merges Claude Code into anthropic and Codex CLI into openai-codex", async (t) => {
	const { root, sessionsDir, cachePath } = fixture(t);
	writeFileSync(
		join(sessionsDir, "pi.jsonl"),
		[
			piSession("s-pi", TS_TODAY, "/pi-proj"),
			piAssistant({ ts: TS_TODAY, provider: "anthropic", model: "claude-opus-5", cost: 1, input: 10, output: 2 }),
			piAssistant({ ts: TS_TODAY + 1, provider: "openai-codex", model: "gpt-6-astra", cost: 0.5, input: 7, output: 1 }),
		].join("\n") + "\n",
	);

	const ccDir = join(root, "claude");
	mkdirSync(ccDir, { recursive: true });
	writeFileSync(
		join(ccDir, "cc.jsonl"),
		JSON.stringify({
			type: "assistant",
			sessionId: "s-cc",
			uuid: "cc-1",
			cwd: "/cc-proj",
			timestamp: TS_TODAY_ISO,
			effort: "high",
			message: {
				model: "claude-opus-5",
				usage: { input_tokens: 3, cache_creation_input_tokens: 8, cache_read_input_tokens: 30, output_tokens: 4 },
			},
		}) + "\n",
	);

	const cxDir = join(root, "codex");
	mkdirSync(cxDir, { recursive: true });
	writeFileSync(
		join(cxDir, "cx.jsonl"),
		[
			JSON.stringify({ timestamp: TS_TODAY_ISO, type: "session_meta", payload: { session_id: "s-cx", cwd: "/cx" } }),
			JSON.stringify({ timestamp: TS_TODAY_ISO, type: "turn_context", payload: { turn_id: "t", model: "gpt-6-astra", effort: "xhigh" } }),
			JSON.stringify({
				timestamp: TS_TODAY_ISO,
				type: "token_usage_record",
				payload: { turn_id: "t", response_id: "r1", usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 6 } },
			}),
		].join("\n") + "\n",
	);

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({
			claudeCode: { enabled: true, roots: [ccDir] },
			codexCli: { enabled: true, roots: [cxDir] },
		}),
	});

	const anthropic = data.allTime.providers.get("anthropic");
	assert.equal(anthropic.messages, 2);
	assert.equal(anthropic.sessions.size, 2);
	assert.equal(anthropic.models.get("claude-opus-5").tokens.input, 13);
	assert.equal(anthropic.models.get("claude-opus-5").tokens.cacheWrite, 8);
	assert.equal(anthropic.models.get("claude-opus-5").tokens.cacheRead, 30);
	assert.ok(anthropic.cost > 1, "Claude Code tokens must add estimated USD on top of Pi invoice");

	const codex = data.allTime.providers.get("openai-codex");
	assert.equal(codex.messages, 2);
	assert.equal(codex.models.get("gpt-6-astra").tokens.input, 7 + 15);
	assert.equal(codex.models.get("gpt-6-astra").tokens.cacheRead, 5);
});

test("collectUsageData merges Grok Build CLI into xai without reading chat_history.jsonl", async (t) => {
	const { root, sessionsDir, cachePath } = fixture(t);
	writeFileSync(
		join(sessionsDir, "pi.jsonl"),
		[piSession("s-pi", TS_TODAY), piAssistant({ ts: TS_TODAY, provider: "grok-build", model: "grok-4.6", cost: 0.2, input: 4, output: 1 })].join("\n") + "\n",
	);
	const grokDir = join(root, "grok", "proj", "sid");
	mkdirSync(grokDir, { recursive: true });
	writeFileSync(
		join(grokDir, "chat_history.jsonl"),
		JSON.stringify({ type: "assistant", model_id: "grok-4.6-build", content: "should not count" }) + "\n",
	);
	writeFileSync(
		join(grokDir, "updates.jsonl"),
		JSON.stringify({
			timestamp: TS_TODAY_SECONDS,
			params: {
				sessionId: "s-gk",
				update: {
					sessionUpdate: "turn_completed",
					prompt_id: "p",
					usage: {
						inputTokens: 100,
						outputTokens: 9,
						cachedReadTokens: 10,
						costUsdTicks: 5_000_000_000,
						modelUsage: { "grok-4.6-build": { inputTokens: 100, outputTokens: 9, cachedReadTokens: 10, costUsdTicks: 5_000_000_000 } },
					},
				},
			},
		}) + "\n",
	);

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({ grokBuild: { enabled: true, roots: [join(root, "grok")] } }),
	});
	assert.equal(data.allTime.providers.has("grok-build"), false);
	const xai = data.allTime.providers.get("xai");
	assert.equal(xai.messages, 2);
	assert.ok(xai.models.get("grok-4.6"));
	assert.ok(xai.models.get("grok-4.6-build"));
	assert.equal(xai.models.get("grok-4.6-build").tokens.input, 90);
	assert.equal(xai.models.get("grok-4.6-build").tokens.cacheRead, 10);
	assert.equal(xai.models.get("grok-4.6-build").cost, 0.5);
});

test("collectUsageData does not double-count a file that appears in both Pi and extra roots", async (t) => {
	const { sessionsDir, cachePath } = fixture(t);
	const shared = join(sessionsDir, "shared.jsonl");
	writeFileSync(shared, [piSession("s1", TS_TODAY), piAssistant({ ts: TS_TODAY, cost: 3, input: 1 })].join("\n") + "\n");

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({ claudeCode: { enabled: true, roots: [sessionsDir] } }),
	});
	assert.equal(data.allTime.totals.cost, 3);
	assert.equal(data.allTime.totals.messages, 1);
});

test("collectUsageData extra-source files with unique sourceIds do not collapse on identical timestamps", async (t) => {
	const { root, sessionsDir, cachePath } = fixture(t);
	writeFileSync(join(sessionsDir, "empty.jsonl"), piSession("s-empty", TS_TODAY) + "\n");
	const ccDir = join(root, "claude");
	mkdirSync(ccDir, { recursive: true });
	writeFileSync(
		join(ccDir, "cc.jsonl"),
		[
			JSON.stringify({
				type: "assistant",
				sessionId: "s-cc",
				uuid: "u1",
				timestamp: TS_TODAY_ISO,
				message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } },
			}),
			JSON.stringify({
				type: "assistant",
				sessionId: "s-cc",
				uuid: "u2",
				timestamp: TS_TODAY_ISO,
				message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } },
			}),
		].join("\n") + "\n",
	);

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({ claudeCode: { enabled: true, roots: [ccDir] } }),
	});
	assert.equal(data.allTime.providers.get("anthropic").messages, 2);
	assert.equal(data.allTime.providers.get("anthropic").tokens.input, 2);
});

// =============================================================================
// OpenCode Go
// =============================================================================

function ocAssistant({
	id = "msg_1",
	sessionID = "ses_1",
	modelID = "muse-spark-1.3-contributor",
	providerID = "opencode-go",
	created = TS_TODAY,
	cost = 0,
	input = 1000,
	output = 40,
	reasoning = 10,
	cacheRead = 200,
	cacheWrite = 0,
	cwd = "/proj",
	error = undefined,
} = {}) {
	return {
		id,
		sessionID,
		role: "assistant",
		time: { created, completed: created + 1 },
		modelID,
		providerID,
		path: { cwd, root: "/" },
		cost,
		tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
		...(error ? { error } : {}),
	};
}

test("canonicalProvider folds grok-build, Pi opencode, and zcode-re into first-class vendors", () => {
	assert.equal(canonicalProvider("grok-build"), "xai");
	assert.equal(canonicalProvider("xai-grok-build"), "xai");
	assert.equal(canonicalProvider("xai"), "xai");
	assert.equal(canonicalProvider("opencode"), "opencode-go");
	// ZCode coding-plan usage reports under the zai provider row.
	assert.equal(canonicalProvider("zcode-re"), "zai");
	assert.equal(canonicalProvider("zai"), "zai");
});

test("mapOpenCodeProvider folds Z.AI plans into zai and keeps opencode-go", () => {
	assert.equal(mapOpenCodeProvider("zai-coding-plan"), "zai");
	assert.equal(mapOpenCodeProvider("zhipu"), "zai");
	assert.equal(mapOpenCodeProvider("opencode-go"), "opencode-go");
	assert.equal(mapOpenCodeProvider("opencode"), "opencode-go");
	assert.equal(mapOpenCodeProvider("opencode-zen"), "opencode-go");
});

test("openCodeTokenAmount does not subtract cache from input", () => {
	assert.deepEqual(
		openCodeTokenAmount({ input: 28069, output: 431, reasoning: 10, cache: { read: 467, write: 3 } }, 0),
		{ cost: 0, input: 28069, output: 431, cacheRead: 467, cacheWrite: 3, reasoning: 10 },
	);
});

test("estimateUsd prices muse-spark-1.3-contributor at OpenCode Go catalog rates", () => {
	assert.equal(
		estimateUsd("opencode-go", "muse-spark-1.3-contributor", {
			cost: 0,
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 0,
			reasoning: 0,
		}),
		0.302,
	);
	assert.equal(
		estimateUsd("opencode", "muse-spark-1.3-contributor-free", {
			cost: 0,
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
		}),
		0,
	);
});

test("parseOpenCodeGoBuffer counts assistant tokens and skips user/zero-token errors", async () => {
	const assistant = await parseOpenCodeGoBuffer(Buffer.from(JSON.stringify(ocAssistant()), "utf8"));
	assert.equal(assistant.sessionId, "ses_1");
	assert.equal(assistant.cwd, "/proj");
	assert.equal(assistant.messages.length, 1);
	assert.equal(assistant.messages[0].provider, "opencode-go");
	assert.equal(assistant.messages[0].model, "muse-spark-1.3-contributor");
	assert.equal(assistant.messages[0].input, 1000);
	assert.equal(assistant.messages[0].cacheRead, 200);
	assert.equal(assistant.messages[0].reasoning, 10);
	assert.equal(
		assistant.messages[0].cost,
		estimateUsd("opencode-go", "muse-spark-1.3-contributor", {
			cost: 0,
			input: 1000,
			output: 40,
			cacheRead: 200,
			cacheWrite: 0,
			reasoning: 10,
		}),
	);

	const user = await parseOpenCodeGoBuffer(
		Buffer.from(JSON.stringify({ id: "msg_u", sessionID: "ses_1", role: "user", time: { created: TS_TODAY } }), "utf8"),
	);
	assert.equal(user.messages.length, 0);
	assert.equal(user.sessionId, "ses_1");

	const failed = await parseOpenCodeGoBuffer(
		Buffer.from(
			JSON.stringify(
				ocAssistant({
					error: { name: "APIError" },
					input: 0,
					output: 0,
					reasoning: 0,
					cacheRead: 0,
					cost: 0,
				}),
			),
			"utf8",
		),
	);
	assert.equal(failed.messages.length, 0);
});

test("parseOpenCodeGoBuffer keeps a recorded invoice instead of estimating", async () => {
	const parsed = await parseOpenCodeGoBuffer(
		Buffer.from(JSON.stringify(ocAssistant({ cost: 1.25, input: 1000, output: 40 })), "utf8"),
	);
	assert.equal(parsed.messages[0].cost, 1.25);
});

test("collectOpenCodeMessageFiles only lists msg_*.json under storage/message", async (t) => {
	const { root } = fixture(t);
	const msgDir = join(root, "storage", "message", "ses_1");
	const partDir = join(root, "storage", "part", "msg_1");
	mkdirSync(msgDir, { recursive: true });
	mkdirSync(partDir, { recursive: true });
	writeFileSync(join(msgDir, "msg_abc.json"), "{}");
	writeFileSync(join(msgDir, "other.json"), "{}");
	writeFileSync(join(partDir, "prt_1.json"), "{}");
	const files = await collectOpenCodeMessageFiles(root);
	assert.deepEqual(files, [join(msgDir, "msg_abc.json")]);
});

test("collectUsageData folds OpenCode Go spark into opencode-go and GLM into zai", async (t) => {
	const { root, sessionsDir, cachePath } = fixture(t);
	writeFileSync(
		join(sessionsDir, "pi.jsonl"),
		[piSession("s-pi", TS_TODAY), piAssistant({ ts: TS_TODAY, provider: "zai", model: "glm-4.7", cost: 0.5, input: 10, output: 2 })].join("\n") + "\n",
	);
	const oc = join(root, "opencode");
	const sparkDir = join(oc, "storage", "message", "ses_spark");
	const glmDir = join(oc, "storage", "message", "ses_glm");
	mkdirSync(sparkDir, { recursive: true });
	mkdirSync(glmDir, { recursive: true });
	writeFileSync(
		join(sparkDir, "msg_spark.json"),
		JSON.stringify(
			ocAssistant({
				id: "msg_spark",
				sessionID: "ses_spark",
				modelID: "muse-spark-1.3-contributor",
				providerID: "opencode-go",
				input: 20_000,
				output: 100,
				cacheRead: 5_000,
			}),
		),
	);
	writeFileSync(
		join(glmDir, "msg_glm.json"),
		JSON.stringify(
			ocAssistant({
				id: "msg_glm",
				sessionID: "ses_glm",
				modelID: "glm-4.7",
				providerID: "zai-coding-plan",
				input: 50,
				output: 5,
				cacheRead: 0,
			}),
		),
	);

	const data = await collectUsageData({
		sessionsDir,
		cachePath,
		now: NOW,
		sources: sourcesFor({ opencodeGo: { enabled: true, roots: [oc] } }),
	});

	const spark = data.allTime.providers.get("opencode-go");
	assert.ok(spark, "opencode-go provider missing");
	assert.equal(spark.messages, 1);
	assert.equal(spark.models.get("muse-spark-1.3-contributor").tokens.input, 20_000);
	assert.ok(spark.cost > 0);

	const zai = data.allTime.providers.get("zai");
	assert.equal(zai.messages, 2);
	assert.equal(zai.models.get("glm-4.7").tokens.input, 60);
	assert.ok(zai.cost > 0.5);
});
