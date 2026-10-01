/**
 * Discovery (LANE store/discover OWNS THIS FILE). Scaffold: a correct but unoptimised implementation on the
 * legacy walkers. Keep the exported API.
 */
import { stat } from "node:fs/promises";
import { collectJsonlFiles, collectNamedFiles, collectOpenCodeMessageFiles } from "../sources.ts";
import type { ResolvedUsageSources, UsageFileKind } from "../sources.ts";
import { compareCanonical } from "./types.ts";
import type { DiscoveredFile } from "./types.ts";

export interface DiscoverOptions {
	sessionsDir: string;
	sources: ResolvedUsageSources;
	signal?: AbortSignal;
}

/** Every source file with its size/mtime, in canonical order; null when aborted. Vanished files are skipped. */
export async function discoverFiles(options: DiscoverOptions): Promise<DiscoveredFile[] | null> {
	const { sessionsDir, sources, signal } = options;
	const seen = new Map<string, UsageFileKind>();
	const add = (paths: string[], kind: UsageFileKind) => {
		for (const p of paths) if (!seen.has(p)) seen.set(p, kind);
	};
	add(await collectJsonlFiles(sessionsDir, signal), "pi");
	const scans: Array<{ enabled: boolean; roots: string[]; kind: UsageFileKind; list: (root: string, s?: AbortSignal) => Promise<string[]> }> = [
		{ ...sources.claudeCode, kind: "claude-code", list: collectJsonlFiles },
		{ ...sources.codexCli, kind: "codex-cli", list: collectJsonlFiles },
		{ ...sources.grokBuild, kind: "grok-build", list: (root, s) => collectNamedFiles(root, "updates.jsonl", s) },
		{ ...sources.opencodeGo, kind: "opencode-go", list: collectOpenCodeMessageFiles },
	];
	for (const scan of scans) {
		if (!scan.enabled) continue;
		for (const root of scan.roots) add(await scan.list(root, signal), scan.kind);
	}
	if (signal?.aborted) return null;
	const entries = [...seen];
	const out: DiscoveredFile[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: 16 }, async () => {
			while (next < entries.length) {
				const [path, kind] = entries[next++]!;
				try {
					const st = await stat(path);
					out.push({ path, kind, size: st.size, mtimeMs: st.mtimeMs });
				} catch {
					// vanished
				}
			}
		})
	);
	if (signal?.aborted) return null;
	return out.sort(compareCanonical);
}
