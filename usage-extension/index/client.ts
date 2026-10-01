/**
 * Process-wide usage index handle (LANE service OWNS THIS FILE). Scaffold: an in-thread core, no worker,
 * no watching. Keep the exported API.
 */
import { UsageIndexCore } from "./service.ts";
import type { UsageIndex, UsageIndexOptions } from "./types.ts";

const REGISTRY = Symbol.for("pi-usage-index");
type Registry = Map<string, UsageIndex>;

function registry(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (g[REGISTRY] ??= new Map());
}

/** One index per (agentDir, sessionsDir, sources, storeDir) per process. */
export function getUsageIndex(options: UsageIndexOptions = {}): UsageIndex {
	const key = JSON.stringify([options.agentDir, options.sessionsDir, options.sources, options.storeDir, options.legacyCachePath]);
	const reg = registry();
	let index = reg.get(key);
	if (!index) {
		const core = new UsageIndexCore(options);
		index = {
			lastRollup: () => core.lastRollup(),
			snapshot: (o) => core.snapshot(o),
			subscribe: () => () => {},
			dispose: async () => {
				reg.delete(key);
				await core.dispose();
			},
		};
		reg.set(key, index);
	}
	return index;
}
