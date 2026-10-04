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
 * - OpenCode Go/CLI: per-message JSON under `storage/message/` (never `storage/part/`).
 *   `tokens.input` is already uncached; cache read/write are separate. Reasoning is a
 *   subset of output. `cost` is used when > 0, otherwise catalog rates (including
 *   `opencode-go/muse-spark-1.3-contributor`).
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChunkParseResult, ParsedSessionFile, SessionMessage, UsageAmount } from "./data.ts";

export type ExtraSourceKind = "claude-code" | "codex-cli" | "grok-build" | "opencode-go";
export type UsageFileKind = "pi" | ExtraSourceKind;

export interface SourceRootConfig {
	enabled: boolean;
	roots: string[];
}

export interface ResolvedUsageSources {
	claudeCode: SourceRootConfig;
	codexCli: SourceRootConfig;
	grokBuild: SourceRootConfig;
	opencodeGo: SourceRootConfig;
}

/** JSON shape under `settings.json` → `usage-extension.sources`. */
export type UsageSourceSetting = boolean | { enabled?: unknown; path?: unknown; paths?: unknown };

export interface UsageSourcesSetting {
	claudeCode?: UsageSourceSetting;
	codexCli?: UsageSourceSetting;
	grokBuild?: UsageSourceSetting;
	opencodeGo?: UsageSourceSetting;
	/** Alias accepted in settings; same store as `opencodeGo`. */
	opencode?: UsageSourceSetting;
}

export function disabledUsageSources(): ResolvedUsageSources {
	return {
		claudeCode: { enabled: false, roots: [] },
		codexCli: { enabled: false, roots: [] },
		grokBuild: { enabled: false, roots: [] },
		opencodeGo: { enabled: false, roots: [] },
	};
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

function defaultClaudeCodeRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.CLAUDE_CONFIG_DIR ?? "").trim();
	if (fromEnv) {
		return splitPathList(fromEnv).map((root) => join(expandHome(root, home), "projects"));
	}
	return [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
}

function defaultCodexCliRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.CODEX_HOME ?? "").trim();
	if (fromEnv) return [join(expandHome(fromEnv, home), "sessions")];
	return [join(home, ".codex", "sessions")];
}

function defaultGrokBuildRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.GROK_HOME ?? "").trim();
	if (fromEnv) return [join(expandHome(fromEnv, home), "sessions")];
	return [join(home, ".grok", "sessions")];
}

function defaultOpenCodeGoRoots(home: string, env: NodeJS.ProcessEnv): string[] {
	const fromEnv = (env.OPENCODE_DATA_DIR ?? "").trim();
	if (fromEnv) return splitPathList(fromEnv).map((root) => expandHome(root, home));
	const xdg = (env.XDG_DATA_HOME ?? "").trim();
	if (xdg) return [join(expandHome(xdg, home), "opencode")];
	return [join(home, ".local", "share", "opencode")];
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
			opencodeGo: resolveOneSource(sources.opencodeGo ?? sources.opencode, defaultOpenCodeGoRoots(home, env), home),
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

function openCodeMessageRoot(root: string): string {
	const normalized = root.replace(/\/+$/, "");
	if (normalized.endsWith("/storage/message")) return normalized;
	if (normalized.endsWith("/storage")) return join(normalized, "message");
	return join(normalized, "storage", "message");
}

export async function collectOpenCodeMessageFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	await walkFiles(openCodeMessageRoot(root), (name, path) => {
		if (name.startsWith("msg_") && name.endsWith(".json")) files.push(path);
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

/** USD per million tokens, from Pi's model catalog. Used only when a log has no invoice. */
interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const MODEL_RATES: Record<string, TokenRates> = {
	// Devin CLI catalog: $0.22 / 1M fresh input, $0.01 cached input,
	// $0.66 output. Pi records cached input separately from fresh input.
	"devin/deepseek-v4.1-flash": { input: 0.22, output: 0.66, cacheRead: 0.01, cacheWrite: 0 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	"grok-4.5": { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	"glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	"glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	"glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
	// SWE-2 is free in Devin Desktop/CLI through 2026-10-10 and publishes no
	// per-token price. Cognition's blog places it at "a quarter of the cost of
	// GPT-6 Astra" ($10/$50 list) → $2.50/$12.50. Cached read uses the
	// standard ~10%-of-input convention used across the Devin catalog
	// (Opus $5→$0.50, Astra $10→$1), NOT Lightning's atypical $1 rate.
	"swe-2": { input: 2.5, output: 12.5, cacheRead: 0.25, cacheWrite: 3.125 },
	"muse-spark-1.3-contributor-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	"muse-spark-1.2-contributor-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	"muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	"muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	"muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
	"muse-spark-1.2": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
};

const PROVIDER_RATES: Record<string, TokenRates> = {
	anthropic: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"openai-codex": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	xai: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	zai: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	// Defensive: zcode-re folds into zai via canonicalProvider, but keep its
	// flagship rates so an un-folded log still prices sensibly.
	"zcode-re": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"opencode-go": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
};

const ZERO_RATES: TokenRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ratesCache = new Map<string, TokenRates>();

/** Memoized: called per message during aggregation (~1M times on big histories). */
function ratesFor(provider: string, model: string): TokenRates {
	const key = provider + "\u0000" + model;
	let rates = ratesCache.get(key);
	if (!rates) {
		rates = lookupRates(provider, model);
		ratesCache.set(key, rates);
	}
	return rates;
}

function lookupRates(provider: string, model: string): TokenRates {
	// Catalog keys are lowercase; session logs mix case (zcode-re records
	// "GLM-5.3-Flash" / "GLM-5.3"), so match case-insensitively.
	const lowered = model.toLowerCase();
	const stripped = lowered.replace(/-build$/, "");
	const providerKey = provider.toLowerCase();
	for (const id of [`${providerKey}/${lowered}`, lowered, `${providerKey}/${stripped}`, stripped]) {
		const exact = MODEL_RATES[id];
		if (exact) return exact;
	}
	let best: TokenRates | undefined;
	let bestLen = 0;
	for (const [id, rates] of Object.entries(MODEL_RATES)) {
		if ((lowered.startsWith(id) || stripped.startsWith(id)) && id.length > bestLen) {
			best = rates;
			bestLen = id.length;
		}
	}
	return best ?? PROVIDER_RATES[providerKey] ?? ZERO_RATES;
}

/** Models with a published $0/free tier that still burn real tokens. Only
 * these get a list-priced equivalent (`estCost`); every other model's
 * estimated cost is its recorded cost — paid models are never repriced. */
const FREE_TIER_MODELS = new Set([
	"swe-2",
	// Z.AI plan routes (zcode-re folds into zai) record $0 — subscription/promo
	// tokens (e.g. the 300M-token promo) cover usage while real tokens burn.
	"glm-5.3",
	"glm-5.3-flash",
]);

/** List-priced USD for free-tier usage; passes recorded cost through for
 * anything else. Used for "what would this have cost" display only. */
export function freeTierUsd(provider: string, model: string, amount: UsageAmount): number {
	if (!FREE_TIER_MODELS.has(model.toLowerCase())) return amount.cost;
	return estimateUsd(provider, model, amount);
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

/** USD per token for fresh (uncached) input from the catalog; 0 when unknown. */
export function catalogInputRate(provider: string, model: string): number {
	return ratesFor(provider, model).input / 1_000_000;
}

/** Cost split by token class. `unsplit` holds cost no rate table could attribute. */
export interface CostParts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	unsplit: number;
}

/**
 * Split `total` USD across token classes. A recorded per-class breakdown wins
 * (rescaled to `total` when the total was repriced, e.g. free-tier list price);
 * otherwise catalog rates apportion it; with no rates it stays `unsplit`.
 */
export function splitCost(
	provider: string,
	model: string,
	amount: UsageAmount,
	total: number,
	recorded?: { input: number; output: number; cacheRead: number; cacheWrite: number }
): CostParts {
	if (total <= 0) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unsplit: 0 };
	let input: number;
	let output: number;
	let cacheRead: number;
	let cacheWrite: number;
	const recordedSum = recorded ? recorded.input + recorded.output + recorded.cacheRead + recorded.cacheWrite : 0;
	if (recorded && recordedSum > 0) {
		({ input, output, cacheRead, cacheWrite } = recorded);
	} else {
		const rates = ratesFor(provider, model);
		input = amount.input * rates.input;
		output = amount.output * rates.output;
		cacheRead = amount.cacheRead * rates.cacheRead;
		cacheWrite = amount.cacheWrite * rates.cacheWrite;
	}
	const sum = input + output + cacheRead + cacheWrite;
	if (sum <= 0) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unsplit: total };
	const k = total / sum;
	return { input: input * k, output: output * k, cacheRead: cacheRead * k, cacheWrite: cacheWrite * k, unsplit: 0 };
}

/** Pi's Devin adapter can record $0 for paid DeepSeek despite token usage.
 * Estimate only this known paid family; never reprice free SWE-2 or replace
 * a nonzero cost reported by the provider. This is not a billing invoice. */
export function pricedDevinCost(provider: string, model: string, amount: UsageAmount): number {
	if (provider !== "devin" || amount.cost !== 0 || model !== "deepseek-v4.1-flash") return amount.cost;
	return estimateUsd(provider, model, amount);
}

function withPricedCost(provider: string, model: string, amount: UsageAmount): UsageAmount {
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

function lineHas(line: Buffer, ...needles: Buffer[]): boolean {
	const head = line.length > 2048 ? line.subarray(0, 2048) : line;
	for (const needle of needles) {
		if (head.includes(needle)) return true;
	}
	return false;
}

/** True when the unterminated bytes from `start` are already a complete JSON object (writer finished the
 * record but not the newline yet). A mid-write object can never parse, so this never consumes a partial line. */
export function unterminatedTailComplete(buffer: Buffer, start: number): boolean {
	let last = buffer.length - 1;
	while (last >= start && (buffer[last] === 0x20 || buffer[last] === 0x09 || buffer[last] === 0x0d)) last--;
	if (last < start || buffer[last] !== 0x7d) return false;
	try {
		JSON.parse(buffer.toString("utf8", start, buffer.length));
		return true;
	} catch {
		return false;
	}
}

/** Returns the bytes consumed: everything, or (completeOnly) through the last "\n". */
async function forEachJsonLine(
	buffer: Buffer,
	relevant: (line: Buffer) => boolean,
	onEntry: (entry: Record<string, unknown>) => void,
	signal?: AbortSignal,
	completeOnly = false,
): Promise<number> {
	let start = 0;
	let consumed = 0;
	let lineNumber = 0;
	while (start < buffer.length) {
		let end = buffer.indexOf(NEWLINE, start);
		if (end === -1) {
			if (completeOnly && !unterminatedTailComplete(buffer, start)) break;
			end = buffer.length;
		}
		lineNumber++;
		if (lineNumber % PARSE_YIELD_EVERY_LINES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (signal?.aborted) return consumed;
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
		consumed = Math.min(start, buffer.length);
	}
	return consumed;
}

type ParserState = Record<string, unknown> | null;

function stateString(state: ParserState, key: string): string {
	const value = state?.[key];
	return typeof value === "string" ? value : "";
}

function chunkToParsed(chunk: ChunkParseResult): ParsedSessionFile {
	return { sessionId: chunk.state.sessionId as string, cwd: chunk.state.cwd as string, messages: chunk.messages, toolUsages: chunk.toolUsages };
}

export async function parseClaudeCodeChunk(buffer: Buffer, state: ParserState, completeOnly: boolean, signal?: AbortSignal): Promise<ChunkParseResult> {
	const messages: SessionMessage[] = [];
	let sessionId = stateString(state, "sessionId");
	let cwd = stateString(state, "cwd");

	const consumed = await forEachJsonLine(
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
		completeOnly,
	);

	return { messages, toolUsages: [], consumed, state: { sessionId, cwd }, reparse: false };
}

export async function parseClaudeCodeBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	return chunkToParsed(await parseClaudeCodeChunk(buffer, null, false, signal));
}

interface CodexContext {
	model: string;
	effort: string;
}

/**
 * Codex attributes each usage record to its turn context as of the END of the file (a later turn_context can
 * re-define an earlier turn, and records without a known turn use the last context). A chunk therefore sets
 * `reparse` when it adds/changes a context that earlier records may have resolved against.
 * State: sessionId, cwd, contexts (turn id -> model/effort, as [id, model, effort] rows), lastContext,
 * fallbackUsed (an earlier record used lastContext).
 */
export async function parseCodexCliChunk(buffer: Buffer, state: ParserState, completeOnly: boolean, signal?: AbortSignal): Promise<ChunkParseResult> {
	let sessionId = stateString(state, "sessionId");
	let cwd = stateString(state, "cwd");
	const contexts = new Map<string, CodexContext>();
	const rows = state?.contexts;
	if (Array.isArray(rows)) {
		for (const row of rows as unknown[]) {
			if (Array.isArray(row)) contexts.set(String(row[0]), { model: String(row[1]), effort: String(row[2]) });
		}
	}
	const lastRaw = asRecord(state?.lastContext);
	let lastContext: CodexContext = lastRaw
		? { model: String(lastRaw.model), effort: String(lastRaw.effort) }
		: { model: "unknown", effort: "" };
	const priorFallbackUsed = state?.fallbackUsed === true;
	let fallbackUsed = priorFallbackUsed;
	let reparse = false;
	let sawContext = false;
	const records: Array<{ turnId: string; sourceId: string; timestamp: number; usage: Record<string, unknown> }> = [];

	const consumed = await forEachJsonLine(
		buffer,
		(line) =>
			lineHas(
				line,
				PATTERN_CODEX_META,
				PATTERN_CODEX_META_SPACED,
				PATTERN_CODEX_TURN,
				PATTERN_CODEX_TURN_SPACED,
				PATTERN_CODEX_USAGE,
				PATTERN_CODEX_USAGE_SPACED,
			),
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
				sawContext = true;
				if (turnId) {
					const known = contexts.get(turnId);
					if (known && (known.model !== model || known.effort !== effort)) reparse = true;
					contexts.set(turnId, ctx);
				}
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
		completeOnly,
	);
	if (priorFallbackUsed && sawContext) reparse = true;

	const messages: SessionMessage[] = [];
	for (const record of records) {
		const amount = codexCliTokenAmount(record.usage);
		if (!amount) continue;
		const known = record.turnId ? contexts.get(record.turnId) : undefined;
		if (!known) fallbackUsed = true;
		const ctx = known || lastContext;
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

	return {
		messages,
		toolUsages: [],
		consumed,
		state: {
			sessionId,
			cwd,
			contexts: [...contexts].map(([id, ctx]) => [id, ctx.model, ctx.effort]),
			lastContext,
			fallbackUsed,
		},
		reparse,
	};
}

export async function parseCodexCliBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	return chunkToParsed(await parseCodexCliChunk(buffer, null, false, signal));
}

export async function parseGrokBuildChunk(buffer: Buffer, state: ParserState, completeOnly: boolean, signal?: AbortSignal): Promise<ChunkParseResult> {
	const messages: SessionMessage[] = [];
	let sessionId = stateString(state, "sessionId");
	const cwd = stateString(state, "cwd");

	const consumed = await forEachJsonLine(
		buffer,
		(line) => lineHas(line, PATTERN_GROK_TURN),
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
		completeOnly,
	);

	return { messages, toolUsages: [], consumed, state: { sessionId, cwd }, reparse: false };
}

export async function parseGrokBuildBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	return chunkToParsed(await parseGrokBuildChunk(buffer, null, false, signal));
}

export function canonicalProvider(provider: string): string {
	if (provider === "opencode" || provider === "opencode-zen") return "opencode-go";
	if (provider === "grok-build" || provider === "xai-grok-build") return "xai";
	// Pi's ZCode coding-plan provider is Z.AI — fold it into zai so plan usage
	// and API usage report as one provider row.
	if (provider === "zcode-re") return "zai";
	return provider;
}

export function mapOpenCodeProvider(providerID: string): string {
	const id = providerID.toLowerCase();
	if (!id || id === "opencode" || id === "opencode-go" || id === "opencode-zen" || id === "zen") return "opencode-go";
	if (id.includes("zai") || id.includes("zhipu")) return "zai";
	if (id.includes("anthropic") || id === "claude") return "anthropic";
	if (id.includes("codex")) return "openai-codex";
	if (id.includes("xai") || id.includes("grok")) return "xai";
	return providerID;
}

export function openCodeTokenAmount(tokens: Record<string, unknown>, cost: unknown): UsageAmount | null {
	const cache = asRecord(tokens.cache);
	return amountOrNull({
		cost: finiteNumber(cost),
		input: finiteNumber(tokens.input),
		output: finiteNumber(tokens.output),
		cacheRead: finiteNumber(cache?.read),
		cacheWrite: finiteNumber(cache?.write),
		reasoning: finiteNumber(tokens.reasoning),
	});
}

export async function parseOpenCodeGoBuffer(buffer: Buffer, _signal?: AbortSignal): Promise<ParsedSessionFile> {
	let entry: Record<string, unknown> | null = null;
	try {
		entry = asRecord(JSON.parse(buffer.toString("utf8")));
	} catch {
		return { sessionId: "", cwd: "", messages: [], toolUsages: [] };
	}
	if (!entry) return { sessionId: "", cwd: "", messages: [], toolUsages: [] };
	const sessionId = typeof entry.sessionID === "string" ? entry.sessionID : "";
	const pathInfo = asRecord(entry.path);
	const cwd = typeof pathInfo?.cwd === "string" ? pathInfo.cwd : "";
	if (entry.role !== "assistant") {
		return { sessionId, cwd, messages: [], toolUsages: [] };
	}
	const tokens = asRecord(entry.tokens);
	if (!tokens) return { sessionId, cwd, messages: [], toolUsages: [] };
	const amount = openCodeTokenAmount(tokens, entry.cost);
	if (!amount) return { sessionId, cwd, messages: [], toolUsages: [] };
	const model = typeof entry.modelID === "string" && entry.modelID ? entry.modelID : "unknown";
	const provider = mapOpenCodeProvider(typeof entry.providerID === "string" ? entry.providerID : "");
	const time = asRecord(entry.time);
	const timestamp = toMillis(time?.completed ?? time?.created);
	const sourceId = typeof entry.id === "string" ? entry.id : "";
	return {
		sessionId,
		cwd,
		messages: [
			assistantMessage({
				provider,
				model,
				thinkingLevel: "",
				sourceId,
				timestamp,
				...withPricedCost(provider, model, amount),
			}),
		],
		toolUsages: [],
	};
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
		case "opencode-go":
			return parseOpenCodeGoBuffer(buffer, signal);
		case "pi":
			if (!parsePi) throw new Error("parseUsageFileBuffer(pi) requires parsePi");
			return parsePi(buffer, signal);
	}
}

/** Resumable chunk parse for the JSONL kinds (opencode-go message files are single documents: not chunkable). */
export async function parseUsageFileChunk(
	kind: UsageFileKind,
	buffer: Buffer,
	state: ParserState,
	completeOnly: boolean,
	signal: AbortSignal | undefined,
	parsePi: (buffer: Buffer, state: ParserState, completeOnly: boolean, signal?: AbortSignal) => Promise<ChunkParseResult>,
): Promise<ChunkParseResult> {
	switch (kind) {
		case "claude-code":
			return parseClaudeCodeChunk(buffer, state, completeOnly, signal);
		case "codex-cli":
			return parseCodexCliChunk(buffer, state, completeOnly, signal);
		case "grok-build":
			return parseGrokBuildChunk(buffer, state, completeOnly, signal);
		case "pi":
			return parsePi(buffer, state, completeOnly, signal);
		case "opencode-go":
			throw new Error("opencode-go files are not chunk-parseable");
	}
}

export function fallbackSessionId(kind: UsageFileKind, filePath: string, parsedId: string): string {
	if (parsedId) return parsedId;
	if (kind === "pi") return "";
	return `ext:${kind}:${filePath}`;
}
