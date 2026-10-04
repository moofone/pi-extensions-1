// Actual /usage component rendering (index.ts), driven through the registered command and the real index.
// Host packages are not installed here: test-only module hooks stub them and add the .ts the pi loader supplies.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const STUBS = {
	"@earendil-works/pi-tui": `
export const visibleWidth=(s)=>String(s).replace(/\\u001b\\[[0-9;]*m/g,"").length;
export const truncateToWidth=(s,n)=>String(s).slice(0,n);
export const wrapTextWithAnsi=(s,n)=>{const out=[];let cur="";for(const w of String(s).split(" ")){if(cur&&(cur+" "+w).length>n){out.push(cur);cur=w}else cur=cur?cur+" "+w:w}if(cur)out.push(cur);return out};
export const matchesKey=(d,k)=>d===k;
export class Container{children=[];addChild(c){this.children.push(c)}render(w){return this.children.flatMap((c)=>c.render(w))}invalidate(){}}
export class Spacer{constructor(n){this.n=n}render(){return Array(this.n).fill("")}}
export class CancellableLoader{constructor(){}setMessage(){}dispose(){}render(){return ["loading"]}invalidate(){}handleInput(){}}
`,
	"@earendil-works/pi-coding-agent": `export class DynamicBorder{constructor(f){this.f=f}render(w){return [this.f("-".repeat(w))]}invalidate(){}}`,
};
registerHooks({
	resolve(specifier, context, next) {
		if (STUBS[specifier]) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
		if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier) && !specifier.endsWith(".json")) {
			for (const ext of [".ts", "/index.ts"]) {
				try { return next(specifier + ext, context); } catch { /* try next */ }
			}
		}
		return next(specifier, context);
	},
});

const root = mkdtempSync(join(tmpdir(), "usage-wf-ui-"));
process.env.PI_CODING_AGENT_DIR = root;
const { default: register } = await import("../usage-extension/index.ts");

const L = (o) => JSON.stringify(o) + "\n";
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const theme = { fg: (_c, s) => s, bold: (s) => s };
const header = (id) => L({ type: "session", version: 3, id, timestamp: iso(now - 5000), cwd: "/anon/project" });
const userLine = (n) => L({ type: "message", id: `u${n}`, parentId: n > 1 ? `a${n - 1}` : null, timestamp: iso(now - 4000 + n), message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: now - 4000 + n } });
const asstLine = (n, cost) => L({ type: "message", id: `a${n}`, parentId: `u${n}`, timestamp: iso(now - 3000 + n), message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "claude-anon", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, timestamp: now - 3000 + n } });

async function open(t, name, text) {
	const dir = join(root, "sessions", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "a.jsonl"), text);
	let component;
	let closed = false;
	let handler;
	register({ registerCommand: (_n, cmd) => (handler = cmd.handler) });
	const tui = { requestRender() {}, terminal: { rows: 60 } };
	const run = handler("", { hasUI: true, ui: { custom: (factory) => new Promise((resolve) => { component = factory(tui, theme, null, () => { closed = true; resolve(); }); }) } });
	t.after(() => { component?.dispose(); rmSync(join(root, "sessions", name), { recursive: true, force: true }); });
	for (let i = 0; i < 400 && !(component?.dashboard); i++) await new Promise((r) => setTimeout(r, 25));
	assert.ok(component?.dashboard, "dashboard shown");
	for (const key of ["v", "v", "v", "v"]) component.handleInput(key); // daily → cache → graph → table → insights
	return { component, closed: () => closed, run };
}

test("component: workflow section renders in the Insights view even when the old cost insights return early (zero cost)", async (t) => {
	const { component } = await open(t, "zero-cost", header("s1") + userLine(1) + asstLine(1, 0));
	const text = component.render(100).join("\n");
	assert.match(text, /No cost data recorded for this period/, "old early return is still shown");
	assert.match(text, /Workflow observations/);
	assert.match(text, /captured assistant record/, "real workflow lens rendered from the real index");
});

test("component: workflow section renders with no assistant usage at all (hasUsage=false path)", async (t) => {
	const { component } = await open(t, "no-usage", header("s2") + userLine(1));
	const text = component.render(100).join("\n");
	assert.match(text, /No usage recorded for this period/);
	assert.match(text, /Workflow observations/);
	assert.ok(!/healthy|waste/i.test(text));
});
