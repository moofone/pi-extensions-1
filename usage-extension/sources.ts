/**
 * Optional extra usage sources (Claude Code, Codex CLI, Grok Build CLI).
 *
 * Default `/usage` remains Pi-only. These parsers exist so the same
 * aggregation in data.ts can fold other local JSONL stores into the same
 * provider/model/thinking buckets when the user opts in.
 *
 * Token-mapping invariants (tested):
 * - Claude Code: `input_tokens` is uncached; cache create/read are separate.
 * - Codex CLI and Grok Build: `input_tokens`/`inputTokens` include cache reads;
 *   fresh input is `input - cached`.
 * - Reasoning tokens are a subset of output, never added on top of it.
 * - Codex `turn_token_usage` / `thread_token_usage` are cumulatives and must
 *   not be counted; only `payload.usage` per `token_usage_record`.
 * - Grok only counts `sessionUpdate === "turn_completed"`; in-progress turns
 *   have no usage row.
 * - Grok `costUsdTicks` is 1e-10 USD.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ParsedSessionFile, SessionMessage, UsageAmount } from "./data.ts";

export type ExtraSourceKind = "claude-code" | "codex-cli" | "grok-build";
export type UsageFileKind = "pi" | ExtraSourceKind;

export interface SourceRootConfig {
	enabled: boolean;
	roots: string[];
}

export interface ResolvedUsageSources {
	claudeCode: SourceRootConfig;
	codexCli: SourceRootConfig;
	grokBuild: SourceRootConfig;
}

/** JSON shape under `settings.json` → `usage-extension.sources`. */
export type UsageSourceSetting = boolean | { enabled?: unknown; path?: unknown; paths?: unknown };

export interface UsageSourcesSetting {
	claudeCode?: UsageSourceSetting;
	codexCli?: UsageSourceSetting;
	grokBuild?: UsageSourceSetting;
}

export function disabledUsageSources(): ResolvedUsageSources {
	return {
		claudeCode: { enabled: false, roots: [] },
		codexCli: { enabled: false, roots: [] },
		grokBuild: { enabled: false, roots: [] },
	};
}

export function anyExtraSourceEnabled(sources: ResolvedUsageSources): boolean {
	return sources.claudeCode.enabled || sources.codexCli.enabled || sources.grokBuild.enabled;
}

const GROK_COST_TICKS_PER_USD = 10_000_000_000;
const PARSE_YIELD_EVERY_LINES = 2000;
const NEWLINE = 0x0a;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function splitPathList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

function coerceEnabled(setting: UsageSourceSetting | undefined): boolean {
	if (setting === true) return true;
	if (setting === false || setting === undefined) return false;
	if (typeof setting.enabled === "boolean") return setting.enabled;
	// `{ path: "..." }` with no enabled flag means on.
	return setting.path !== undefined || setting.paths !== undefined;
}

function coercePaths(setting: UsageSourceSetting | undefined): string[] {
	if (!setting || typeof setting === "boolean") return [];
	const paths: string[] = [];
	if (typeof setting.path === "string" && setting.path.trim()) paths.push(setting.path.trim());
	if (Array.isArray(setting.paths)) {
		for (const item of setting.paths) {
			if (typeof item === "string" && item.trim()) paths.push(item.trim());
		}
	}
	return paths;
}

export function defaultClaudeCodeRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.CLAUDE_CONFIG_DIR ?? "").trim();
	if (fromEnv) {
		return splitPathList(fromEnv).map((root) => join(expandHome(root, home), "projects"));
	}
	return [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
}

export function defaultCodexCliRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.CODEX_HOME ?? "").trim();
	if (fromEnv) return [join(expandHome(fromEnv, home), "sessions")];
	return [join(home, ".codex", "sessions")];
}

export function defaultGrokBuildRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.GROK_HOME ?? "").trim();
	if (fromEnv) return [join(expandHome(fromEnv, home), "sessions")];
	return [join(home, ".grok", "sessions")];
}

/**
 * Parse `usage-extension.sources` from settings.json. Missing/invalid files
 * yield every extra source disabled so `/usage` stays Pi-only by default.
 */
export function parseUsageSourcesSetting(
	settingsJson: string,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): ResolvedUsageSources {
	const disabled = disabledUsageSources();
	try {
		const parsed = JSON.parse(settingsJson) as { "usage-extension"?: { sources?: UsageSourcesSetting } };
		const sources = parsed["usage-extension"]?.sources;
		if (!sources || typeof sources !== "object") return disabled;
		return {
			claudeCode: resolveOneSource(sources.claudeCode, defaultClaudeCodeRoots(home, env), home),
			codexCli: resolveOneSource(sources.codexCli, defaultCodexCliRoots(home, env), home),
			grokBuild: resolveOneSource(sources.grokBuild, defaultGrokBuildRoots(home, env), home),
		};
	} catch {
		return disabled;
	}
}

function resolveOneSource(setting: UsageSourceSetting | undefined, defaults: string[], home: string): SourceRootConfig {
	const enabled = coerceEnabled(setting);
	if (!enabled) return { enabled: false, roots: [] };
	const override = coercePaths(setting).map((path) => expandHome(path, home));
	return { enabled: true, roots: override.length > 0 ? override : defaults };
}

export async function collectJsonlFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	await walkFiles(dir, (name, path) => {
		if (name.endsWith(".jsonl")) files.push(path);
	}, signal);
	files.sort();
	return files;
}

export async function collectNamedFiles(dir: string, fileName: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	await walkFiles(dir, (name, path) => {
		if (name === fileName) files.push(path);
	}, signal);
	files.sort();
	return files;
}

async function walkFiles(
	dir: string,
	visit: (name: string, path: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (signal?.aborted) return;
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walkFiles(entryPath, visit, signal);
			} else if (entry.isFile()) {
				visit(entry.name, entryPath);
			}
		}
	} catch {
		// Skip directories we can't read — same policy as Pi session discovery.
	}
}

function toMillis(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1e12 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
			return numeric > 1e12 ? numeric : numeric * 1000;
		}
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function amountOrNull(amount: UsageAmount): UsageAmount | null {
	return amount.cost === 0 &&
		amount.input === 0 &&
		amount.output === 0 &&
		amount.cacheRead === 0 &&
		amount.cacheWrite === 0 &&
		amount.reasoning === 0
		? null
		: amount;
}

function assistantMessage(fields: Omit<SessionMessage, "source" | "afterCompaction"> & { sourceId: string }): SessionMessage {
	return {
		...fields,
		source: "assistant",
		afterCompaction: false,
	};
}

function splitInclusiveCache(inputIncludingCache: number, cachedRead: number): { input: number; cacheRead: number } {
	const cacheRead = Math.max(0, cachedRead);
	const input = Math.max(0, inputIncludingCache - cacheRead);
	return { input, cacheRead };
}

export function claudeCodeTokenAmount(usage: Record<string, unknown>): UsageAmount | null {
	const details = asRecord(usage.output_tokens_details);
	return amountOrNull({
		cost: finiteNumber(usage.costUSD ?? usage.cost_usd),
		input: finiteNumber(usage.input_tokens),
		output: finiteNumber(usage.output_tokens),
		cacheRead: finiteNumber(usage.cache_read_input_tokens),
		cacheWrite: finiteNumber(usage.cache_creation_input_tokens),
		reasoning: finiteNumber(details?.thinking_tokens),
	});
}

export function codexCliTokenAmount(usage: Record<string, unknown>): UsageAmount | null {
	const cached = finiteNumber(usage.cached_input_tokens);
	const { input, cacheRead } = splitInclusiveCache(finiteNumber(usage.input_tokens), cached);
	return amountOrNull({
		cost: finiteNumber(usage.cost_usd ?? usage.costUSD),
		input,
		output: finiteNumber(usage.output_tokens),
		cacheRead,
		cacheWrite: finiteNumber(usage.cache_write_input_tokens),
		reasoning: finiteNumber(usage.reasoning_output_tokens),
	});
}

export function grokBuildTokenAmount(usage: Record<string, unknown>): UsageAmount | null {
	const cached = finiteNumber(usage.cachedReadTokens);
	const { input, cacheRead } = splitInclusiveCache(finiteNumber(usage.inputTokens), cached);
	return amountOrNull({
		cost: finiteNumber(usage.costUsdTicks) / GROK_COST_TICKS_PER_USD,
		input,
		output: finiteNumber(usage.outputTokens),
		cacheRead,
		cacheWrite: finiteNumber(usage.cacheCreationTokens),
		reasoning: finiteNumber(usage.reasoningTokens),
	});
}

/** USD per million tokens, copied from Pi's model catalog. Used only when a log has no invoice. */
export interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const MODEL_RATES: Record<string, TokenRates> = {
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	"grok-4.5": { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
};

const PROVIDER_RATES: Record<string, TokenRates> = {
	anthropic: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"openai-codex": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	xai: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
};

const ZERO_RATES: TokenRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function ratesFor(provider: string, model: string): TokenRates {
	const stripped = model.replace(/-build$/, "");
	for (const id of [model, stripped]) {
		const exact = MODEL_RATES[id];
		if (exact) return exact;
	}
	let best: TokenRates | undefined;
	let bestLen = 0;
	for (const [id, rates] of Object.entries(MODEL_RATES)) {
		if ((model.startsWith(id) || stripped.startsWith(id)) && id.length > bestLen) {
			best = rates;
			bestLen = id.length;
		}
	}
	return best ?? PROVIDER_RATES[provider] ?? ZERO_RATES;
}

/** Catalog estimate in USD. Extra-source logs often store tokens with no invoice. */
export function estimateUsd(provider: string, model: string, amount: UsageAmount): number {
	const rates = ratesFor(provider, model);
	return (
		(amount.input * rates.input +
			amount.output * rates.output +
			amount.cacheRead * rates.cacheRead +
			amount.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

export function withPricedCost(provider: string, model: string, amount: UsageAmount): UsageAmount {
	if (amount.cost !== 0) return amount;
	const cost = estimateUsd(provider, model, amount);
	return cost === 0 ? amount : { ...amount, cost };
}

const PATTERN_CC_ASSISTANT_COMPACT = Buffer.from('"type":"assistant"');
const PATTERN_CC_ASSISTANT_SPACED = Buffer.from('"type": "assistant"');
const PATTERN_CODEX_META = Buffer.from('"type":"session_meta"');
const PATTERN_CODEX_META_SPACED = Buffer.from('"type": "session_meta"');
const PATTERN_CODEX_TURN = Buffer.from('"type":"turn_context"');
const PATTERN_CODEX_TURN_SPACED = Buffer.from('"type": "turn_context"');
const PATTERN_CODEX_USAGE = Buffer.from('"type":"token_usage_record"');
const PATTERN_CODEX_USAGE_SPACED = Buffer.from('"type": "token_usage_record"');
const PATTERN_GROK_TURN = Buffer.from("turn_completed");

function lineHas(line: Buffer, compact: Buffer, spaced: Buffer): boolean {
	const head = line.length > 2048 ? line.subarray(0, 2048) : line;
	return head.includes(compact) || head.includes(spaced);
}

async function forEachJsonLine(
	buffer: Buffer,
	relevant: (line: Buffer) => boolean,
	onEntry: (entry: Record<string, unknown>) => void,
	signal?: AbortSignal,
): Promise<void> {
	let start = 0;
	let lineNumber = 0;
	while (start < buffer.length) {
		let end = buffer.indexOf(NEWLINE, start);
		if (end === -1) end = buffer.length;
		lineNumber++;
		if (lineNumber % PARSE_YIELD_EVERY_LINES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (signal?.aborted) return;
		}
		if (end > start) {
			const line = buffer.subarray(start, end);
			if (relevant(line)) {
				try {
					const parsed: unknown = JSON.parse(buffer.toString("utf8", start, end));
					const entry = asRecord(parsed);
					if (entry) onEntry(entry);
				} catch {
					// Skip malformed lines.
				}
			}
		}
		start = end + 1;
	}
}

export async function parseClaudeCodeBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	const messages: SessionMessage[] = [];
	let sessionId = "";
	let cwd = "";

	await forEachJsonLine(
		buffer,
		(line) => lineHas(line, PATTERN_CC_ASSISTANT_COMPACT, PATTERN_CC_ASSISTANT_SPACED),
		(entry) => {
			if (entry.type !== "assistant") return;
			if (typeof entry.sessionId === "string" && !sessionId) sessionId = entry.sessionId;
			if (typeof entry.cwd === "string" && !cwd) cwd = entry.cwd;
			const message = asRecord(entry.message);
			if (!message) return;
			const usage = asRecord(message.usage);
			if (!usage) return;
			const amount = claudeCodeTokenAmount(usage);
			if (!amount) return;
			const model = typeof message.model === "string" && message.model ? message.model : "unknown";
			const thinkingLevel = typeof entry.effort === "string" ? entry.effort : "";
			const sourceId = typeof entry.uuid === "string" ? entry.uuid : typeof message.id === "string" ? message.id : "";
			messages.push(
				assistantMessage({
					provider: "anthropic",
					model,
					thinkingLevel,
					sourceId,
					timestamp: toMillis(entry.timestamp),
					...withPricedCost("anthropic", model, amount),
				}),
			);
		},
		signal,
	);

	return { sessionId, cwd, messages, toolUsages: [] };
}

export async function parseCodexCliBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	let sessionId = "";
	let cwd = "";
	const contexts = new Map<string, { model: string; effort: string }>();
	let lastContext = { model: "unknown", effort: "" };
	const records: Array<{ turnId: string; sourceId: string; timestamp: number; usage: Record<string, unknown> }> = [];

	await forEachJsonLine(
		buffer,
		(line) =>
			lineHas(line, PATTERN_CODEX_META, PATTERN_CODEX_META_SPACED) ||
			lineHas(line, PATTERN_CODEX_TURN, PATTERN_CODEX_TURN_SPACED) ||
			lineHas(line, PATTERN_CODEX_USAGE, PATTERN_CODEX_USAGE_SPACED),
		(entry) => {
			const payload = asRecord(entry.payload) ?? {};
			if (entry.type === "session_meta") {
				if (typeof payload.session_id === "string" && payload.session_id) sessionId = payload.session_id;
				else if (typeof payload.id === "string" && payload.id) sessionId = payload.id;
				if (typeof payload.cwd === "string") cwd = payload.cwd;
				return;
			}
			if (entry.type === "turn_context") {
				const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
				const model = typeof payload.model === "string" && payload.model ? payload.model : "unknown";
				const effort = typeof payload.effort === "string" ? payload.effort : "";
				const ctx = { model, effort };
				if (turnId) contexts.set(turnId, ctx);
				lastContext = ctx;
				if (typeof payload.cwd === "string" && !cwd) cwd = payload.cwd;
				return;
			}
			if (entry.type !== "token_usage_record") return;
			const usage = asRecord(payload.usage);
			if (!usage) return;
			records.push({
				turnId: typeof payload.turn_id === "string" ? payload.turn_id : "",
				sourceId: typeof payload.response_id === "string" ? payload.response_id : "",
				timestamp: toMillis(entry.timestamp),
				usage,
			});
		},
		signal,
	);

	const messages: SessionMessage[] = [];
	for (const record of records) {
		const amount = codexCliTokenAmount(record.usage);
		if (!amount) continue;
		const ctx = (record.turnId && contexts.get(record.turnId)) || lastContext;
		messages.push(
			assistantMessage({
				provider: "openai-codex",
				model: ctx.model,
				thinkingLevel: ctx.effort,
				sourceId: record.sourceId,
				timestamp: record.timestamp,
				...withPricedCost("openai-codex", ctx.model, amount),
			}),
		);
	}

	return { sessionId, cwd, messages, toolUsages: [] };
}

export async function parseGrokBuildBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	const messages: SessionMessage[] = [];
	let sessionId = "";
	let cwd = "";

	await forEachJsonLine(
		buffer,
		(line) => line.includes(PATTERN_GROK_TURN),
		(entry) => {
			const params = asRecord(entry.params);
			const update = asRecord(params?.update);
			if (!update || update.sessionUpdate !== "turn_completed") return;
			if (typeof params?.sessionId === "string" && params.sessionId && !sessionId) {
				sessionId = params.sessionId;
			}
			const usage = asRecord(update.usage);
			if (!usage) return;
			const timestamp = toMillis(entry.timestamp);
			const promptId = typeof update.prompt_id === "string" ? update.prompt_id : "";
			const modelUsage = asRecord(usage.modelUsage);
			const rows: Array<{ model: string; usage: Record<string, unknown> }> = [];
			if (modelUsage) {
				for (const [model, raw] of Object.entries(modelUsage)) {
					const row = asRecord(raw);
					if (row) rows.push({ model, usage: row });
				}
			}
			if (rows.length === 0) rows.push({ model: "unknown", usage });
			for (const row of rows) {
				const amount = grokBuildTokenAmount(row.usage);
				if (!amount) continue;
				messages.push(
					assistantMessage({
						provider: "xai",
						model: row.model,
						thinkingLevel: "",
						sourceId: promptId ? `${promptId}:${row.model}` : row.model,
						timestamp,
						...withPricedCost("xai", row.model, amount),
					}),
				);
			}
		},
		signal,
	);

	return { sessionId, cwd, messages, toolUsages: [] };
}

export async function parseUsageFileBuffer(
	kind: UsageFileKind,
	buffer: Buffer,
	signal?: AbortSignal,
	parsePi?: (buffer: Buffer, signal?: AbortSignal) => Promise<ParsedSessionFile>,
): Promise<ParsedSessionFile> {
	switch (kind) {
		case "claude-code":
			return parseClaudeCodeBuffer(buffer, signal);
		case "codex-cli":
			return parseCodexCliBuffer(buffer, signal);
		case "grok-build":
			return parseGrokBuildBuffer(buffer, signal);
		case "pi":
			if (!parsePi) throw new Error("parseUsageFileBuffer(pi) requires parsePi");
			return parsePi(buffer, signal);
	}
}

export function fallbackSessionId(kind: UsageFileKind, filePath: string, parsedId: string): string {
	if (parsedId) return parsedId;
	if (kind === "pi") return "";
	return `ext:${kind}:${filePath}`;
}
