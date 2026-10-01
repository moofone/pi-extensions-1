/**
 * Persistent store (LANE store/discover OWNS THIS FILE). Scaffold: memory only. Keep the exported API.
 */
import type { FileRecord, IndexStore } from "./types.ts";

export interface OpenStoreOptions {
	/** Legacy single-file cache (v6/v7) imported once when the store has nothing yet; null → none. */
	legacyCachePath?: string | null;
}

/** `dir` null → memory only. */
export function openIndexStore(dir: string | null, options: OpenStoreOptions = {}): IndexStore {
	void dir;
	void options;
	const records = new Map<string, FileRecord>();
	let rollup: unknown = null;
	return {
		async load() {
			return new Map(records);
		},
		put(record) {
			records.set(record.path, record);
		},
		delete(path) {
			records.delete(path);
		},
		async flush() {},
		async readRollup() {
			return rollup;
		},
		async writeRollup(payload) {
			rollup = payload;
		},
	};
}
