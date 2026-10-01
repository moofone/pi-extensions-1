/**
 * Index measurements for tests/bench-usage-index.mjs (real history, read-only; every store under `dir`):
 *   index.cold         fresh store importing a copy of the legacy cache → first snapshot (in-process core)
 *   index.fresh-warm   CHILD node process: getUsageIndex (worker) on that store → snapshot; total + main-thread stall
 *   index.warm         second snapshot on the warm core
 *   index.append       synthetic /tmp history: append 5 turns to one session → refresh + snapshot
 *   index.equivalence  index snapshot vs collectUsageDataLegacy on the real history (assertUsageDataEqual)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function run({ root, dir, sources, now, out, stallProbe, legacyCache }) {
	const { UsageIndexCore } = await import(join(root, "usage-extension/index/service.ts"));
	const { collectUsageDataLegacy, getSessionsDir } = await import(join(root, "usage-extension/data.ts"));
	const { appendTurns, assertUsageDataEqual, makeHistory } = await import(pathToFileURL(join(root, "tests/usage-index-support.mjs")).href);
	const sessionsDir = getSessionsDir();

	// --- cold -----------------------------------------------------------------------------------------------
	const storeDir = join(dir, "index-store");
	const legacyCopy = join(dir, "index-legacy-copy.json");
	rmSync(storeDir, { recursive: true, force: true });
	if (existsSync(legacyCache)) copyFileSync(legacyCache, legacyCopy);
	const options = { sessionsDir, sources, storeDir, legacyCachePath: existsSync(legacyCopy) ? legacyCopy : null, worker: false };
	const core = new UsageIndexCore(options);
	let data;
	{
		const stop = stallProbe();
		const t0 = performance.now();
		let parsedFiles = 0;
		data = await core.snapshot({ now, onProgress: (p) => (parsedFiles = p.filesToParse) });
		out("index.cold", t0, { maxStallMs: stop(), filesParsed: parsedFiles, allTimeCost: Math.round(data.allTime.totals.cost) });
	}
	await core.flush();

	// --- fresh process, store on disk (the worker keeps the main thread free) ----------------------------------
	{
		const child = join(dir, "index-fresh-warm-child.mjs");
		writeFileSync(
			child,
			`const { getUsageIndex } = await import(${JSON.stringify(join(root, "usage-extension/index/client.ts"))});
const sources = ${JSON.stringify(sources)};
let last = performance.now(), worst = 0;
const timer = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 10); last = t; }, 10);
const index = getUsageIndex({ sessionsDir: ${JSON.stringify(sessionsDir)}, sources, storeDir: ${JSON.stringify(storeDir)}, legacyCachePath: null, worker: true, watch: false });
const t0 = performance.now();
const rollup = await index.lastRollup();
const rollupMs = Math.round(performance.now() - t0);
let toParse = -1;
const data = await index.snapshot({ now: new Date(${now.getTime()}), onProgress: (p) => (toParse = p.filesToParse) });
const ms = Math.round(performance.now() - t0);
clearInterval(timer);
console.log(JSON.stringify({ ms, maxStallMs: Math.round(worst), rollupMs, hadRollup: rollup !== null, filesToParse: toParse, allTimeCost: Math.round(data.allTime.totals.cost), rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
await index.dispose();
process.exit(0);
`
		);
		const t0 = performance.now();
		const result = await new Promise((resolve) => {
			const proc = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", child], { stdio: ["ignore", "pipe", "inherit"] });
			let text = "";
			proc.stdout.on("data", (d) => (text += d));
			proc.on("close", () => resolve(text.trim().split("\n").pop()));
		});
		let parsed = {};
		try {
			parsed = JSON.parse(result);
		} catch {
			parsed = { error: String(result).slice(0, 200) };
		}
		out("index.fresh-warm", t0, { ...parsed, ms: parsed.ms ?? Math.round(performance.now() - t0), childTotalMs: Math.round(performance.now() - t0) });
	}

	// --- warm snapshot on the live (watching) core -----------------------------------------------------------------
	// index.warm-nothing-dirty: refresh() alone with nothing dirty must skip the filesystem; index.warm: the full
	// snapshot (refresh + ledger.snapshot). Live sessions may dirty a few paths in between (reported).
	{
		await core.refresh(); // absorb events that arrived during the cold build
		const sweeps = core.fullSweeps;
		const checked = core.dirtyPathsChecked;
		let t0 = performance.now();
		await core.refresh();
		out("index.warm-nothing-dirty", t0, { fullSweeps: core.fullSweeps - sweeps, dirtyChecked: core.dirtyPathsChecked - checked });
		const stop = stallProbe();
		t0 = performance.now();
		await core.snapshot({ now });
		out("index.warm", t0, { maxStallMs: stop(), fullSweeps: core.fullSweeps - sweeps });
	}

	// --- watched append on a synthetic history ---------------------------------------------------------------------
	{
		const history = join(dir, "append-history");
		rmSync(history, { recursive: true, force: true });
		mkdirSync(history, { recursive: true });
		const files = makeHistory(history, { seed: 5, sessions: 400, now: now.getTime() });
		rmSync(join(dir, "append-store"), { recursive: true, force: true });
		const appendCore = new UsageIndexCore({ sessionsDir: history, storeDir: join(dir, "append-store"), legacyCachePath: null, worker: false });
		await appendCore.snapshot({ now });
		await new Promise((r) => setTimeout(r, 500));
		await appendCore.snapshot({ now });
		const target = files[Math.floor(files.length / 2)];
		const sweeps = appendCore.fullSweeps;
		appendTurns(target, 5, 123, now.getTime() - 60_000);
		await new Promise((r) => setTimeout(r, 200)); // fs event delivery
		const t0 = performance.now();
		await appendCore.snapshot({ now });
		out("index.append", t0, { files: files.length, fullSweeps: appendCore.fullSweeps - sweeps, dirtyChecked: appendCore.dirtyPathsChecked });
		await appendCore.dispose();

		// Same through the worker host: append → subscriber notified (watch debounce + refresh) → snapshot.
		const { getUsageIndex } = await import(join(root, "usage-extension/index/client.ts"));
		const index = getUsageIndex({ sessionsDir: history, storeDir: null, legacyCachePath: null, worker: true, parseWorkers: 0 });
		await index.snapshot({ now });
		let fired = null;
		const unsubscribe = index.subscribe(() => (fired ??= performance.now()));
		await new Promise((r) => setTimeout(r, 800));
		const a0 = performance.now();
		appendTurns(files[1], 5, 321, now.getTime() - 30_000);
		for (let i = 0; i < 400 && fired === null; i++) await new Promise((r) => setTimeout(r, 10));
		const notifyMs = fired === null ? null : Math.round(fired - a0);
		const t1 = performance.now();
		await index.snapshot({ now });
		out("index.watched-append", a0, { notifyMs, snapshotAfterNotifyMs: Math.round(performance.now() - t1) });
		unsubscribe();
		await index.dispose();
		rmSync(history, { recursive: true, force: true });
	}

	// --- equivalence vs legacy on the real history -----------------------------------------------------------------
	// The real history keeps growing while benchmarks run (live pi sessions), so a live comparison only counts when
	// the file set (path, size, mtime) was identical before and after both collectors ran (3 tries). With
	// BENCH_FROZEN=1 the Pi sessions are APFS-cloned (cp -c, read-only on the source) into `dir` and both
	// collectors run cold on that frozen copy with extra sources disabled — a deterministic comparison.
	{
		const { discoverFiles } = await import(join(root, "usage-extension/index/discover.ts"));
		const { disabledUsageSources } = await import(join(root, "usage-extension/sources.ts"));
		const t0 = performance.now();
		let ok = false;
		let error = "history kept changing";
		let attempts = 0;
		let mode = "live";
		if (process.env.BENCH_FROZEN) {
			mode = "frozen";
			const frozen = join(dir, "sessions-frozen");
			rmSync(frozen, { recursive: true, force: true });
			await new Promise((resolve, reject) => spawn("cp", ["-cR", sessionsDir, frozen], { stdio: "inherit" }).on("close", (c) => (c === 0 ? resolve() : reject(new Error(`cp ${c}`)))));
			const frozenCore = new UsageIndexCore({ sessionsDir: frozen, sources: disabledUsageSources(), storeDir: null, legacyCachePath: null, worker: false, watch: false });
			const actual = await frozenCore.snapshot({ now });
			const expected = await collectUsageDataLegacy({ sessionsDir: frozen, cachePath: null, sources: disabledUsageSources(), now });
			await frozenCore.dispose();
			attempts = 1;
			try {
				assertUsageDataEqual(actual, expected, "index vs legacy (frozen real history)");
				ok = true;
				error = undefined;
			} catch (e) {
				error = String(e.message).slice(0, 300);
			}
			rmSync(frozen, { recursive: true, force: true });
		} else {
			const fingerprint = async () => (await discoverFiles({ sessionsDir, sources })).map((f) => `${f.path}:${f.size}:${f.mtimeMs}`).join("\n");
			while (attempts < 3) {
				attempts++;
				const before = await fingerprint();
				const actual = await core.snapshot({ now });
				const expected = await collectUsageDataLegacy({ cachePath: legacyCache, sources, now });
				if ((await fingerprint()) !== before) continue;
				try {
					assertUsageDataEqual(actual, expected, "index vs legacy (real history)");
					ok = true;
					error = undefined;
				} catch (e) {
					error = String(e.message).slice(0, 300);
				}
				break;
			}
		}
		out("index.equivalence", t0, { ok: error === "history kept changing" ? null : ok, mode, attempts, ...(error ? { error } : {}) });
	}
	await core.dispose();
}
