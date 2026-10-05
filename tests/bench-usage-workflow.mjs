// Not a test: node tests/bench-usage-workflow.mjs [files] [turnsPerFile]. Synthetic normalized workload:
// cold index, no-change snapshot, one-file append snapshot (full workflow aggregation over every capture).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageIndexCore } from "../usage-extension/index/service.ts";
import { buildWorkflowSnapshot } from "../usage-extension/workflow/analyze.ts";
import { parseSessionChunk } from "../usage-extension/data.ts";

const files = Number(process.argv[2] ?? 300);
const turns = Number(process.argv[3] ?? 300);
const L = (o) => JSON.stringify(o) + "\n";
const now = Date.now();
const root = mkdtempSync(join(tmpdir(), "usage-wf-bench-"));
const dir = join(root, "sessions", "--anon--");
mkdirSync(dir, { recursive: true });
const turn = (f, i) =>
	L({ type: "message", id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: new Date(now - 86_400_000 + i * 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: `task ${f} ${i}` }] } }) +
	L({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: new Date(now - 86_400_000 + i * 1000 + 500).toISOString(), message: { role: "assistant", provider: "p", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "npm test -- --run" } }], usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.01 } }, timestamp: now - 86_400_000 + i * 1000 + 500 } }) +
	L({ type: "message", id: `t${i}`, parentId: `a${i}`, timestamp: new Date(now - 86_400_000 + i * 1000 + 900).toISOString(), message: { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false } });
for (let f = 0; f < files; f++) {
	let text = L({ type: "session", id: `s${f}`, timestamp: new Date(now - 86_400_000).toISOString(), cwd: "/anon" });
	for (let i = 0; i < turns; i++) text += turn(f, i);
	writeFileSync(join(dir, `f${f}.jsonl`), text);
}
const ms = (t) => (performance.now() - t).toFixed(1) + "ms";
const core = new UsageIndexCore({ sessionsDir: join(root, "sessions"), storeDir: null, legacyCachePath: null, worker: false, watch: false, parseWorkers: 0 });
let t = performance.now();
let data = await core.snapshot({});
console.log(`cold index (${files} files x ${turns * 3} records): ${ms(t)}; workflow records=${files * (turns * 3 + 1)}`);
t = performance.now(); data = await core.snapshot({}); console.log(`no-change snapshot: ${ms(t)}`);
const caps = [];
for (const r of core.records.values()) caps.push({ sessionId: r.parsed.sessionId, capture: r.parsed.workflow });
t = performance.now(); buildWorkflowSnapshot(caps); console.log(`buildWorkflowSnapshot alone (full pass): ${ms(t)}`);
appendFileSync(join(dir, "f0.jsonl"), turn(0, turns));
t = performance.now(); data = await core.snapshot({}); console.log(`one-file append snapshot (reparse tail + full aggregation): ${ms(t)}`);
const big = Buffer.from(L({ type: "session", id: "x" }) + Array.from({ length: 30000 }, (_, i) => turn(1, i)).join(""));
t = performance.now(); await parseSessionChunk(big, null, true); console.log(`parse one capped 30k-record file (${(big.length / 1e6).toFixed(1)}MB): ${ms(t)}`);
await core.dispose();
rmSync(root, { recursive: true, force: true });
