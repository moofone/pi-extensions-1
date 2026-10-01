/**
 * Resumable parsing (LANE parse OWNS THIS FILE). Scaffold: always a full parse, never resumable. Keep the
 * exported API; `parseFileDelta` must stay worker-safe (plain-data in, plain-data out).
 */
import { readFile } from "node:fs/promises";
import { parseSessionBuffer } from "../data.ts";
import type { ParsedSessionFile } from "../data.ts";
import { fallbackSessionId, parseUsageFileBuffer } from "../sources.ts";
import type { DiscoveredFile, FileRecord, ParseFile, ParseOutcome, ResumeState } from "./types.ts";

/** What one parse produced: the records of the parsed byte range only, and where to resume next time. */
export interface ParseDelta {
	/** "full": `delta` is the whole file; "append": `delta` holds only records after `resume` of the previous
	 * parse (sessionId/cwd in `delta` are the file's, unchanged); "none": nothing new. */
	mode: "full" | "append" | "none";
	delta: ParsedSessionFile;
	resume: ResumeState | null;
}

/** Parse what changed in `file` given the previous resume state (null → full). null when unreadable/aborted.
 * Worker-safe: no shared state, only plain data crosses the boundary. */
export async function parseFileDelta(file: DiscoveredFile, previous: ResumeState | null, signal?: AbortSignal): Promise<ParseDelta | null> {
	void previous;
	let buffer: Buffer;
	try {
		buffer = await readFile(file.path);
	} catch {
		return null;
	}
	const parsed = await parseUsageFileBuffer(file.kind, buffer, signal, parseSessionBuffer);
	if (signal?.aborted) return null;
	parsed.sessionId = fallbackSessionId(file.kind, file.path, parsed.sessionId);
	return { mode: "full", delta: parsed, resume: null };
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
