#!/usr/bin/env node
/**
 * Usage collection benchmark on the REAL history (read-only: ~/.pi/agent/sessions and the extra stores
 * enabled in ~/.pi/agent/settings.json). Caches/stores go under /tmp/usage-bench-<worktree>/ only.
 *
 *   node tests/bench-usage-index.mjs                 # legacy warm (cache built if missing) + index, if present
 *   node tests/bench-usage-index.mjs --cold          # also time a cold legacy build (≈1 min: run sparingly)
 *   node tests/bench-usage-index.mjs --legacy-only   # skip the index
 *
 * Prints one JSON line per measurement: { name, ms, rssMB, ... }. Lanes may add measurements for their
 * layer at the end (keep the existing names stable so runs stay comparable).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = `/tmp/usage-bench-${basename(root)}`;
mkdirSync(dir, { recursive: true });
const args = new Set(process.argv.slice(2));
const { collectUsageDataLegacy, getAgentDir } = await import(join(root, "usage-extension/data.ts"));
const { parseUsageSourcesSetting } = await import(join(root, "usage-extension/sources.ts"));
const sources = parseUsageSourcesSetting(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
const now = new Date();
const out = (name, t0, extra = {}) =>
	console.log(JSON.stringify({ name, ms: Math.round(performance.now() - t0), rssMB: Math.round(process.memoryUsage().rss / 1e6), ...extra }));

// Main-thread stall probe: the longest gap between 10 ms ticks while a task runs.
function stallProbe() {
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const t = performance.now();
		worst = Math.max(worst, t - last - 10);
		last = t;
	}, 10);
	return () => {
		clearInterval(timer);
		return Math.round(worst);
	};
}

const legacyCache = join(dir, "legacy-cache.json");
if (args.has("--cold")) rmSync(legacyCache, { force: true });
{
	const stop = stallProbe();
	const t0 = performance.now();
	const data = await collectUsageDataLegacy({ cachePath: legacyCache, sources, now });
	out(existsSync(legacyCache) && !args.has("--cold") ? "legacy.warm-or-build" : "legacy.cold", t0, { maxStallMs: stop(), allTimeCost: Math.round(data.allTime.totals.cost) });
}
{
	const stop = stallProbe();
	const t0 = performance.now();
	await collectUsageDataLegacy({ cachePath: legacyCache, sources, now });
	out("legacy.warm", t0, { maxStallMs: stop() });
}

if (!args.has("--legacy-only") && existsSync(join(root, "usage-extension/index/client.ts"))) {
	// The service lane fills this in: cold index build, fresh-process warm, warm snapshot, append latency,
	// equivalence vs legacy on the real history. Keep names: index.cold, index.fresh-warm, index.warm,
	// index.append, index.equivalence.
	const bench = join(root, "tests/bench-usage-index.index.mjs");
	if (existsSync(bench)) await (await import(bench)).run({ root, dir, sources, now, out, stallProbe, legacyCache });
}
