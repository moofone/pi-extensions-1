/**
 * Resumable parsing. JSONL kinds (pi, claude-code, codex-cli, grok-build) are parsed in chunks of complete
 * lines; `ResumeState` carries the parser state at the cut, so an append only reads (and parses) the new bytes.
 * opencode-go message files are single JSON documents: always a whole-file parse, `resume: null`.
 *
 * An unterminated last line is consumed only when it is already a complete JSON object (same result as the
 * legacy full parse); a partial line is left for the next parse.
 *
 * `parseFileDelta` must stay worker-safe (plain-data in, plain-data out, no module state).
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { parseSessionChunk } from "../data.ts";
import type { ChunkParseResult, ParsedSessionFile } from "../data.ts";
import { fallbackSessionId, parseOpenCodeGoBuffer, parseUsageFileChunk } from "../sources.ts";
import type { DiscoveredFile, FileRecord, ParseFile, ParseOutcome, ResumeState } from "./types.ts";

/** What one parse produced: the records of the parsed byte range only, and where to resume next time. */
export interface ParseDelta {
	/** "full": `delta` is the whole file; "append": `delta` holds only records after `resume` of the previous
	 * parse (sessionId/cwd in `delta` are the file's, unchanged); "none": nothing new. */
	mode: "full" | "append" | "none";
	delta: ParsedSessionFile;
	resume: ResumeState | null;
}

const HASH_BYTES = 256;

function sha1(buffer: Buffer): string {
	return createHash("sha1").update(buffer).digest("hex");
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer | null> {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead === 0) return null;
		filled += bytesRead;
	}
	return buffer;
}

/** Read [0, size) (or less if the file shrank meanwhile). */
async function readWhole(handle: FileHandle, size: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(size);
	let filled = 0;
	while (filled < size) {
		const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return filled === size ? buffer : buffer.subarray(0, filled);
}

function validResume(value: ResumeState | null): value is ResumeState {
	return (
		!!value &&
		Number.isSafeInteger(value.offset) &&
		value.offset >= 0 &&
		typeof value.headHash === "string" &&
		typeof value.tailHash === "string" &&
		!!value.state &&
		typeof value.state === "object"
	);
}

function parseChunk(kind: DiscoveredFile["kind"], buffer: Buffer, state: Record<string, unknown> | null, signal?: AbortSignal): Promise<ChunkParseResult> {
	return parseUsageFileChunk(kind, buffer, state, true, signal, parseSessionChunk);
}

function deltaOf(file: DiscoveredFile, chunk: ChunkParseResult): ParsedSessionFile {
	const state = chunk.state;
	return {
		sessionId: fallbackSessionId(file.kind, file.path, (state.sessionId as string) ?? ""),
		cwd: typeof state.cwd === "string" ? state.cwd : "",
		messages: chunk.messages,
		toolUsages: chunk.toolUsages,
	};
}

/** Full parse of a whole-file buffer. */
async function fullParse(file: DiscoveredFile, buffer: Buffer, signal?: AbortSignal): Promise<ParseDelta | null> {
	if (file.kind === "opencode-go") {
		const parsed = await parseOpenCodeGoBuffer(buffer, signal);
		if (signal?.aborted) return null;
		parsed.sessionId = fallbackSessionId(file.kind, file.path, parsed.sessionId);
		return { mode: "full", delta: parsed, resume: null };
	}
	const chunk = await parseChunk(file.kind, buffer, null, signal);
	if (signal?.aborted) return null;
	const resume: ResumeState = {
		offset: chunk.consumed,
		headHash: sha1(buffer.subarray(0, Math.min(HASH_BYTES, chunk.consumed))),
		tailHash: sha1(buffer.subarray(Math.max(0, chunk.consumed - HASH_BYTES), chunk.consumed)),
		state: chunk.state,
	};
	return { mode: "full", delta: deltaOf(file, chunk), resume };
}

/** Parse what changed in `file` given the previous resume state (null → full). null when unreadable/aborted.
 * Worker-safe: no shared state, only plain data crosses the boundary. */
export async function parseFileDelta(file: DiscoveredFile, previous: ResumeState | null, signal?: AbortSignal): Promise<ParseDelta | null> {
	if (file.kind === "opencode-go") {
		let buffer: Buffer;
		try {
			buffer = await readFile(file.path);
		} catch {
			return null;
		}
		return fullParse(file, buffer, signal);
	}

	let handle: FileHandle;
	try {
		handle = await open(file.path, "r");
	} catch {
		return null;
	}
	try {
		const size = (await handle.stat()).size;
		if (validResume(previous) && size >= previous.offset) {
			const appended = await tryAppend(handle, file, previous, size, signal);
			if (signal?.aborted) return null;
			if (appended) return appended;
		}
		const buffer = await readWhole(handle, size);
		return await fullParse(file, buffer, signal);
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Validate head/tail and parse only [offset, size). null → caller must do a full parse. */
async function tryAppend(handle: FileHandle, file: DiscoveredFile, previous: ResumeState, size: number, signal?: AbortSignal): Promise<ParseDelta | null> {
	const { offset } = previous;
	const headLength = Math.min(HASH_BYTES, offset);
	const tailStart = Math.max(0, offset - HASH_BYTES);
	// One read covers both ranges when they overlap/touch.
	let head: Buffer | null;
	let tail: Buffer | null;
	if (offset <= 2 * HASH_BYTES) {
		const both = await readExact(handle, 0, offset);
		if (!both) return null;
		head = both.subarray(0, headLength);
		tail = both.subarray(tailStart, offset);
	} else {
		head = await readExact(handle, 0, headLength);
		tail = await readExact(handle, tailStart, offset - tailStart);
		if (!head || !tail) return null;
	}
	if (sha1(head) !== previous.headHash || sha1(tail) !== previous.tailHash) return null;

	const prior = previous.state;
	if (size === offset) return noneDelta(file, previous);
	const chunkBuffer = await readExact(handle, offset, size - offset);
	if (!chunkBuffer) return null;
	const chunk = await parseChunk(file.kind, chunkBuffer, prior, signal);
	if (signal?.aborted) return null;
	if (chunk.reparse) return null;
	// Append keeps sessionId/cwd (types.ts): a chunk that learns or changes them forces a full parse.
	if ((chunk.state.sessionId ?? "") !== (prior.sessionId ?? "") || (chunk.state.cwd ?? "") !== (prior.cwd ?? "")) return null;
	if (chunk.consumed === 0) return noneDelta(file, previous);

	const newOffset = offset + chunk.consumed;
	const consumedBytes = chunkBuffer.subarray(0, chunk.consumed);
	const resume: ResumeState = {
		offset: newOffset,
		headHash:
			offset >= HASH_BYTES
				? previous.headHash
				: sha1(Buffer.concat([head, consumedBytes]).subarray(0, Math.min(HASH_BYTES, newOffset))),
		tailHash:
			chunk.consumed >= HASH_BYTES
				? sha1(consumedBytes.subarray(chunk.consumed - HASH_BYTES))
				: sha1(Buffer.concat([tail, consumedBytes]).subarray(-Math.min(HASH_BYTES, newOffset))),
		state: chunk.state,
	};
	return { mode: "append", delta: deltaOf(file, chunk), resume };
}

function noneDelta(file: DiscoveredFile, previous: ResumeState): ParseDelta {
	return {
		mode: "none",
		delta: {
			sessionId: fallbackSessionId(file.kind, file.path, (previous.state.sessionId as string) ?? ""),
			cwd: typeof previous.state.cwd === "string" ? previous.state.cwd : "",
			messages: [],
			toolUsages: [],
		},
		resume: previous,
	};
}

/** Merge a delta into the previous record → the new record and what changed. */
export function applyParseDelta(file: DiscoveredFile, previous: FileRecord | undefined, result: ParseDelta): ParseOutcome {
	const base = { path: file.path, kind: file.kind, size: file.size, mtimeMs: file.mtimeMs, resume: result.resume };
	if (result.mode === "full" || !previous) return { record: { ...base, parsed: result.delta }, change: { type: "full" } };
	if (result.mode === "none") return { record: { ...base, parsed: previous.parsed }, change: { type: "none" } };
	const parsed: ParsedSessionFile = {
		sessionId: previous.parsed.sessionId,
		cwd: previous.parsed.cwd,
		messages: [...previous.parsed.messages, ...result.delta.messages],
		toolUsages: [...previous.parsed.toolUsages, ...result.delta.toolUsages],
	};
	return {
		record: { ...base, parsed },
		change: { type: "append", messagesFrom: previous.parsed.messages.length, toolUsagesFrom: previous.parsed.toolUsages.length },
	};
}

export const parseFile: ParseFile = async (file, previous, signal) => {
	const result = await parseFileDelta(file, previous?.resume ?? null, signal);
	return result ? applyParseDelta(file, previous, result) : null;
};
