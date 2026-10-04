// index.ts uses TypeScript parameter properties, which plain type stripping rejects: run the real-component
// harness in a child Node with --experimental-transform-types (no installs; same Node).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual /usage component renders workflow observations (child harness)", () => {
	const harness = new URL("./usage-workflow-component.harness.mjs", import.meta.url).pathname;
	const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--test", "--test-force-exit", "--test-reporter=tap", harness], { encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /# pass 2\b/);
	assert.match(r.stdout, /# fail 0\b/);
});
