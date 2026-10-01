// The scaffold pipeline (stub layers) must already equal the legacy oracle; every lane keeps this green.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectUsageDataLegacy } from "../usage-extension/data.ts";
import { UsageIndexCore } from "../usage-extension/index/service.ts";
import { appendTurns, assertUsageDataEqual, makeHistory } from "./usage-index-support.mjs";

const NOW = new Date(2026, 9, 1, 16, 17, 0);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "usage-index-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, sessionsDir: join(root, "sessions") };
}

test("index core snapshot equals the legacy collector (fresh, after appends, after a delete)", async (t) => {
	const { sessionsDir } = fixture(t);
	const files = makeHistory(sessionsDir, { seed: 7, sessions: 14, now: NOW.getTime() });
	const core = new UsageIndexCore({ sessionsDir, storeDir: null, legacyCachePath: null, worker: false, watch: false });
	const legacy = () => collectUsageDataLegacy({ sessionsDir, cachePath: null, now: NOW });

	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(), "fresh");

	appendTurns(files[0], 5, 99, NOW.getTime() - 900_000);
	appendTurns(files[files.length - 1], 3, 100, NOW.getTime() - 600_000);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(), "after appends");

	rmSync(files[1]);
	assertUsageDataEqual(await core.snapshot({ now: NOW }), await legacy(), "after delete");
});
